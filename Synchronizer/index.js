import WebSocket from 'ws';
import Big from 'big.js';
import fetch from 'node-fetch';
import crypto from 'crypto';
import exchanges from './Exchanges/index.js';
import { CompressAndSendBigJSONToS3 } from "../helper/sendToS3.js";

import dotenv from 'dotenv';
dotenv.config();

// Commonjs importing 
import pkg from 'node-gzip';
const { ungzip } = pkg;

class Synchronizer {
  constructor (exchange, base, quote, delay = 1) {
    this.orderbook_depth = 50;       // Defines the max depth od the orderbook.
    this.seconds_to_export = 1800;   // Defines how many seconds at most we will wait before exporting the data saved in memory. (if '1800' each 30min, if '3600' each hour, etc..)
    this.exchange = exchange;        // Defines the exchange name we will synchronize with.
    this.base = base;                // Stores the 'base' of the market we will synchronize with.
    this.quote = quote;              // Stores the 'quote' of the market we will synchronize with.
    
    this.is_test = false;            // Sets if this synchronization is just a test or if we should realy store data.

    this.completely_synced = false;  // Stores the current STATE of the object. (Is it synchronized ?)
    this.process_second_timeout;     // Control variable for the timeout of 'process_second' function.

    this.markets = null;             // Stores exchange available markets.

    this.orderbook = null;           // Stores the current (real-time) orderbook.
    this.orderbook_upd_cache = [];   // Store orderbook updates while the first orderbook snapshot is not defined.

    this.orderbooks = [];            // Stores the last orderbooks for each second since 'now - (delay_time_in_seconds + 2)'.
    this.delayed_orderbook = null;   // Stores the lastest orderbook for 'now - delay_time_in_seconds'.

    this.trades = null;              // Stores the last trades since 'now - (delay_time_in_seconds + 2)'.
    this.trades_upd_cache = [];      // Stores new trades while the first trades snapshot is not defined.
    this.synced_trades_since = null; // Stores the timestamp since 'trades' are synchronized.

    this.seconds_data = [];          // Stores the orderbook and trades from each second.
    this.saved_first_second = false; // Defines if the first second has already been saved. (Avoids 'no orderbook' error before the first save)

    this.exc = null;                 // Stores the exchange configuration JSON. 
    this.api = {};                   // Stores the exchange credentials if needed.
    this.market = {};                // Stores 2 variations (for WebScoket and REST) of the market name we will synchronize with.
    this.ws_req_nonce = 0;           // Stores a nonce used as unique ID for request/response messaging with the WebScoket.
    this.authenticate = null;        // Stores a function used to sign requests that require authentication.
    this.get_auth_headers = null;    // Stores a function that returns all required authentication headers for REST requests that require authentication.

    this.connections = [];           // Stores all WebSocket connections.
    this.connections_num = 3;        // Sets the number of simultaneos connections it should open.
    this.connection_tries = [];      // Stores the timestamp of the last attempts to connect to the server.
    this.max_attemps_per_min = 3;    // Sets the maximuim connection attemps per minute to avoid flooding the server.
    this.conn_attemp_delay = 20e3;   // Defines the minimum delay in milliseconds that we must wait to try a new connection to the server, if we have failed 'max_attemps_per_min' times.

    this.attemp_delay = {};          // Stores the attemp_delay promises.
    this._url_nonce = 0;             // Stores the url nonce, used when multiple connections w/ multiple endpoints.

    this.__working = true;

    // Test latency vars.
    this.is_lantecy_test = false;
    this.conn_latency = [];
    this.subr_latency = [];
    this.diff_latency = [];
  }

  async rest_request (endpoint, url_replaces = [], is_pagination = false) {
    try {
      const _rest = this.exc.rest;
      const _endpoint = _rest.endpoints[endpoint];
      const resp_info = _endpoint?.response;
  
      let url = (_rest.url + _endpoint.path);
      let headers = _rest.headers || {};
  
      if (is_pagination) {
        url += (resp_info?.pagination?.to_add_url || '');
        url = url.replace((resp_info?.pagination?.to_del_url || ''), '');
      }
  
      for (const [ url_code, value ] of url_replaces)
        url = url.replaceAll(url_code, value);
  
      if (_endpoint.require_auth)
        headers = { ...headers, ...this.get_auth_headers(url.replace(_rest.url, '')) };
      
      let r = await Promise.race([
        new Promise((res, rej) => setTimeout(rej, (_rest.timeout || 5000), "TIMEOUT")),
        fetch(url, {
          method: _endpoint.method || "GET",
          headers
        })
        .then(r => r.text())
      ]);

      try {
        r = JSON.parse(r);
      } catch (e) {
        console.log('[E] Request response is not JSON:',r);
        return { success: false, response: r }
      }
        
      // Check for error.
      let is_error = false;
      let resp_error = _rest.error.key?.split('.')?.reduce((f, k) => f?.[k], r);
      if (resp_error != undefined) {
        if (_rest.error.is_array) {
          is_error = (resp_error.length > 0);
        } else if (_rest.error.value_not != undefined) {
          is_error = (resp_error != _rest.error.value_not);
        } else {
          is_error = (_rest.error.value == undefined || resp_error == _rest.error.value);
        }
      }
      if (is_error) throw resp_error;
  
      // Format response.
      if (resp_info?.get_first_value != undefined) {
        r = Object.values(r)[0];
      } else if (resp_info?.data_inside != undefined) {
        r = resp_info.data_inside?.split('.')?.reduce((f, k) => f?.[k], r);
      }
      if (resp_info?.foreach_concat_inside != undefined) 
        r = r?.reduce((s, v) => [ ...s, ...v[resp_info.foreach_concat_inside]], []);
  
      // Return response.
      return { success: true, response: r };

    } catch (error) {
      return { success: false, response: error };
    }
  }

  format_timestamp (ts, at) {
    if (ts == null) return ts;

    if (this.exc.timestamp_ISO_format || at.timestamp_ISO_format) 
      ts = new Date(ts).getTime();
    else if (this.exc.timestamp_in_seconds || at.timestamp_in_seconds) 
      ts = Big(ts).times(1e3).round(0, 0).toFixed() * 1;
    else if (this.exc.timestamp_in_micro || at.timestamp_in_micro)
      ts = Big(ts).div(1e3).round(0, 0).toFixed() * 1;
    else if (this.exc.timestamp_in_nano || at.timestamp_in_nano)
      ts = Big(ts).div(1e6).round(0, 0).toFixed() * 1;
    else
      ts = Big(ts).round(0, 0).toFixed() * 1;

    return ts;
  }

  make_subscriptions (__ws, _ws, _prom, conn) {
    // Send some data before subscriptions if needed.
    if (_ws.to_send_before_subcriptions != undefined) {
      for (const data of _ws.to_send_before_subcriptions)
        __ws.send(data);
    }

    // Send 'trades' subscription request.
    if (_ws.not_handle_trades !== true) {
      if (_ws.subcriptions.trades?.request != undefined) {
        let trades_sub_req = _ws.subcriptions.trades.request
          .replaceAll('<market>', this.market.ws)
          .replace('<ws_req_id>', ++this.ws_req_nonce);
        
        conn.info.trades.req_id = _ws.subcriptions.trades.response?.id_value?.replaceAll('<market>', this.market.ws) || this.ws_req_nonce;

        // If needed, authenticate the orderbook subscription request.
        if (_ws.subcriptions.trades.require_auth) {
          const { signature, sign_nonce } = this.authenticate();
          
          trades_sub_req = trades_sub_req
          .replace('<api_key>', this.api.key)
          .replace('<api_pass>', this.api.pass)
          .replace('<sign_nonce>', sign_nonce)
          .replace('<signature>', signature);
        }
        
        conn._sent_trades_sub_at = Date.now();
        __ws.send(trades_sub_req);
      }

      // If no trades subscription response is expected, then we should assume that 'info.trades.is_subscribed' is true from here.
      if (_ws.subcriptions.trades?.response == undefined && (
        _ws.subcriptions.trades?.request != undefined ||
        _ws.subcriptions.trades?.is_subscribed_from_scratch
      )) {
        if (this.is_lantecy_test) this.subr_latency.push(undefined);
        conn.info.trades.is_subscribed = true;
        if (!this.silent_mode) console.log('[!] ('+conn._idx+') Successfully subscribed to trades updates.');

        // Resolve the promise if 'not_handle_orderbook' or 'orderbook' is already successfuly subscribed.
        if (_prom && (
          _ws.not_handle_orderbook === true ||
          conn.info.orderbook?.is_subscribed === true
        ))
          _prom.resolve();
      }
    }

    // Send 'orderbook' subscription request.
    if (_ws.not_handle_orderbook !== true) {
      if (_ws.subcriptions.orderbook?.request != undefined) {
        let orderbook_sub_req = _ws.subcriptions.orderbook.request
          .replaceAll('<market>', this.market.ws)
          .replace('<ws_req_id>', ++this.ws_req_nonce);
        
        conn.info.orderbook.req_id = _ws.subcriptions.orderbook.response?.id_value?.replaceAll('<market>', this.market.ws) || this.ws_req_nonce;

        // If needed, authenticate the orderbook subscription request.
        if (_ws.subcriptions.orderbook.require_auth) {
          const { signature, sign_nonce } = this.authenticate();
          
          orderbook_sub_req = orderbook_sub_req
          .replace('<api_key>', this.api.key)
          .replace('<api_pass>', this.api.pass)
          .replace('<sign_nonce>', sign_nonce)
          .replace('<signature>', signature);
        }
        
        conn._sent_orderbook_sub_at = Date.now();
        __ws.send(orderbook_sub_req);
      }

      // If no orderbook subscription response' is expected, then we should assume that 'info.orderbook.is_upds_subscribed' is true from here.
      if (_ws.subcriptions.orderbook?.response == undefined && (
        _ws.subcriptions.orderbook?.request != undefined ||
        _ws.subcriptions.orderbook?.is_subscribed_from_scratch
      )) {
        if (this.is_lantecy_test) this.subr_latency.push(undefined);
        conn.info.orderbook.is_subscribed = true;
        if (!this.silent_mode) console.log('[!] ('+conn._idx+') Successfully subscribed to orderbook updates.');
          
        // Resolve the promise if 'not_handle_trades' or 'trades' is already successfuly subscribed.
        if (_prom && (
          _ws.not_handle_trades === true ||
          conn.info.trades?.is_subscribed === true
        ))
          _prom.resolve();
      }

      // Send 'orderbook_snap' subscription request.
      if (_ws.subcriptions.orderbook_snap?.request != undefined) {
        let orderbook_snap_sub_req = _ws.subcriptions.orderbook_snap.request
          .replaceAll('<market>', this.market.ws)
          .replace('<ws_req_id>', ++this.ws_req_nonce);

        conn.info.orderbook_snap.req_id = _ws.subcriptions.orderbook_snap.response?.id_value?.replaceAll('<market>', this.market.ws) || this.ws_req_nonce;
        
        conn._sent_orderbook_snap_sub_at = Date.now();
        __ws.send(orderbook_snap_sub_req);
      }
      
      // If no 'orderbook_snap' subscription response' is expected, then we should assume that 'info.orderbook_snap.is_subscribed' is true from here.
      if (_ws.subcriptions.orderbook_snap?.response == undefined && (
        _ws.subcriptions.orderbook_snap?.request != undefined ||
        _ws.subcriptions.orderbook_snap?.is_subscribed_from_scratch
      )) {
        conn.info.orderbook_snap.is_subscribed = true;
        if (!this.silent_mode) console.log('[!] ('+conn._idx+') Successfully subscribed to orderbook snapshot updates.');
      }
    }
  }

  handle_trades_sub_resp (msg, _ws, __ws, _prom, conn, ws_recv_ts) {
    const _id_val = _ws.subcriptions.trades?.response?.channel_id_key?.split('.').reduce((f, k) => f?.[k], msg);

    if (_ws.subcriptions.trades.update.channel_id) {
      conn.info.trades.channel_id = _ws.subcriptions.trades.update.channel_id.replaceAll('<market>', this.market.ws);

    } else if (_id_val != undefined && (
      _ws.subcriptions.trades.response.channel_id_val == undefined ||
      _id_val == _ws.subcriptions.trades.response.channel_id_val.replaceAll('<market>', this.market.ws)
    )) {
      conn.info.trades.channel_id = _id_val;
      
    } else {
      if (_prom) {
        _prom.reject({ 
          At: "Handling trades subcription response:", 
          error: "Neither 'trades.response.channel_id_key' or 'trades.update.channel_id' are defined." 
        });
      } else {
        console.log("[E] Handling trades subcription response: \
        Neither 'trades.response.channel_id_key' or 'trades.update.channel_id' are defined.\
        \n\nEnding connection...");
        __ws.terminate();
      }

      return;
    }

    const now = Date.now();
    if (this.is_lantecy_test) {
      conn._recv_trades_subr_at = ws_recv_ts;
      this.subr_latency.push(conn._recv_trades_subr_at - conn._sent_trades_sub_at);
    }
    conn.info.trades.is_subscribed = true;
    if (!this.silent_mode) console.log('[!] ('+conn._idx+') Successfully subscribed to trades updates.');
    if (this.synced_trades_since == null || Big(now).lt(this.synced_trades_since))
      this.synced_trades_since = now;

    // If 'not_handle_orderbook' or 'info.orderbook.is_subscribed' resolve the promise.
    if (_prom && (
      _ws.not_handle_orderbook === true || 
      conn.info.orderbook?.is_subscribed
    ))
      _prom.resolve();
  }

  format_trades_msg (msg, _ws, __ws, _prom, conn) {
    // This function must receive the 'trades' message and format it to the pattern below.
    // (The array must be formatted in ascending order ordered by 'timestamp')
    // [
    //   {
    //     timestamp: <trade time in ms>,
    //     is_buy: <true | false>,
    //     price: <trade price>,
    //     amount: <trade amount in base asset>
    //   },
    //   ...
    // ]
    // console.log('Trades msg:',msg.params[1]);

    const _t_upd = _ws.subcriptions.trades.update;

    // Checks if its the first update.
    if (conn.info.trades.received_first_update !== true) {
      conn.info.trades.received_first_update = true;
      
      // Ignore the first update if needed.
      if (_t_upd.ignore_first_update === true) return null;
    }
    
    // Check if channel message should be ignored ('ignore_if').
    for (const [ key, value ] of (_t_upd.ignore_if || [])) {
      if (msg[key] === value) return null;
    }

    // Handle 'data_inside'.
    msg = (_t_upd.data_inside?.split('.')?.reduce((f, k) => f?.[k], msg) || msg);

    // console.log('Trades msg:',msg);
  
    // If receive each trade as a unique object, insert this trade into an array.
    if (_t_upd.receive_separately_trades_as_obj) msg = [ msg ];

    // Get raw trades and if necessary revert it.
    let raw_trades = (_t_upd.trades_inside?.split('.')?.reduce((f, k) => f?.[k], msg) || msg);
    if (_t_upd.reiceve_array_w_newer_first) raw_trades.reverse();

    // Return formated trades.
    let trades = [];
    for (const t of raw_trades) {
      const _ts = (_t_upd?.timestamp?.split('.')?.reduce((f, k) => f?.[k], t) || _t_upd?.timestamp?.split('.')?.reduce((f, k) => f?.[k], msg));

      let obj = {
        timestamp: this.format_timestamp(_ts, _t_upd),
        is_buy: undefined,
        price: Big(_t_upd.price?.split('.')?.reduce((f, k) => f?.[k], t)).toFixed(),
        amount: Big(_t_upd.amount?.split('.')?.reduce((f, k) => f?.[k], t)).toFixed()
      };

      // Try to define 'timestamp_us'.
      if (_t_upd.get_timestamp_us_from_iso) {
        obj.timestamp_us = new Date(_ts).getTime() + _ts.slice(23, -1);
      } else if (this.exc.timestamp_in_micro || _t_upd.timestamp_in_micro) {
        obj.timestamp_us = _ts;
      }

      if (_t_upd.is_buy_key != undefined) {
        obj.is_buy = (t[_t_upd.is_buy_key] == _t_upd.is_buy_value);
  
      } else if (_t_upd.is_buy_positive_amount === true) {
        obj.is_buy = Big(obj.amount).gt(0);
        obj.amount = Big(obj.amount).abs().toFixed();
  
      } else {
        if (_prom) {
          _prom.reject({ 
            At: "Parsing trades update message:", 
            error: "Neither 'trades.update.is_buy_key' or 'trades.update.is_buy_positive_amount' are defined." 
          });
        } else {
          console.log("[E] Parsing trades update message: \
          Neither 'trades.update.is_buy_key' or 'trades.update.is_buy_positive_amount' are defined.\
          \n\nEnding connection...");
          __ws.terminate();
        }
        return;
      }

      obj.trade_id = _t_upd.trade_id_key?.split('.')?.reduce((f, k) => f?.[k], t);
      obj.custom_id = '' + obj.timestamp + obj.is_buy + obj.price + obj.amount;

      trades.push(obj);
    }
    
    return trades;
  }

  handle_trades_msg (update, _ws) {
    if (update == null) return; // Ignore.

    const _t_upd = _ws.subcriptions.trades.update;
    const _id_key = _t_upd.trade_id_key != undefined ? 'trade_id' : 'custom_id';

    if (this.trades == null || this.trades_upd_cache.length > 0) {
      // Add to 'trades_upd_cache' trades that not already in 'trades_upd_cache'.

      const _last = this.trades_upd_cache?.slice(-1)?.[0];

      if (_id_key == 'trade_id' && _t_upd.id_should_be_higher)
        update = update.filter(trade => this.trades_upd_cache.length == 0 || Big(trade[_id_key]).gt(_last[_id_key]));
      else {
        const _ts_key = ((this.exc.timestamp_in_micro || _t_upd.timestamp_in_micro || _t_upd.get_timestamp_us_from_iso) && _last?.timestamp_us) ? "timestamp_us" : "timestamp";
        update = update.filter(trade => this.trades_upd_cache.length == 0 || (Big(trade[_ts_key]).gte(_last[_ts_key]) && this.trades_upd_cache.every(t => t[_id_key] != trade[_id_key])));
      }

      this.trades_upd_cache = [ ...this.trades_upd_cache, ...update ];

    } else {
      // Add to 'trades' trades that not already in 'trades'.

      const _last = this.trades?.slice(-1)?.[0];
                                                              /* Can be a trade coming from REST snapshot wo/ 'trade_id' or not. */
      if (_id_key == 'trade_id' && _t_upd.id_should_be_higher && _last?.trade_id != undefined)
        update = update.filter(trade => this.trades.length == 0 || Big(trade[_id_key]).gt(_last[_id_key]));
      else {
        const _ts_key = ((this.exc.timestamp_in_micro || _t_upd.timestamp_in_micro || _t_upd.get_timestamp_us_from_iso) && _last?.timestamp_us) ? "timestamp_us" : "timestamp";
        update = update.filter(trade => this.trades.length == 0 || (Big(trade[_ts_key]).gte(_last[_ts_key]) && this.trades.every(t => t[_id_key] != trade[_id_key])));
      }
      
      this.trades = [ ...this.trades, ...update ];
    }
  }

  handle_orderbook_sub_resp (msg, _ws, __ws, _prom, conn, ws_recv_ts, is_snap = false) {
    const _ob = is_snap ? 'orderbook_snap' : 'orderbook';
    const _sub = _ws.subcriptions?.[_ob];
    const _info = conn.info[_ob];
    const _id_val = _sub?.response?.channel_id_key?.split('.').reduce((f, k) => f?.[k], msg);

    if (_sub?.update?.channel_id) {
      _info.channel_id = _sub.update.channel_id.replaceAll('<market>', this.market.ws);
      
    } else if (_id_val != undefined && (
      _sub?.response?.channel_id_val == undefined ||
      _id_val == _sub.response.channel_id_val.replaceAll('<market>', this.market.ws)
    )) {
      _info.channel_id = _id_val;

    } else {
      if (_prom) {
        _prom.reject({ 
          At: "Handling "+_ob+" subcription response:", 
          error: "Neither '"+_ob+".response.channel_id_key' or '"+_ob+".update.channel_id' are defined." 
        });
      } else {
        console.log("[E] Handling "+_ob+" subcription response: \
        Neither '"+_ob+".response.channel_id_key' or '"+_ob+".update.channel_id' are defined.\
        \n\nEnding connection...");
        __ws.terminate();
      }

      return;
    }

    if (_ob == "orderbook") {
      if (this.is_lantecy_test) {
        conn._recv_orderbook_subr_at = ws_recv_ts;
        this.subr_latency.push(conn._recv_orderbook_subr_at - conn._sent_orderbook_sub_at);
      }
      _info.is_subscribed = true;
      if (!this.silent_mode) console.log('[!] ('+conn._idx+') Successfully subscribed to orderbook updates.');

      // If 'not_handle_trades' or 'info.trades.is_subscribed' resolve the promise.
      if (_prom &&
      (_ws.not_handle_trades === true || conn.info.trades?.is_subscribed) &&
      (_ws.subcriptions.orderbook_snap == null || conn.info.orderbook_snap?.is_subscribed))
        _prom.resolve();

    } else {
      if (this.is_lantecy_test) {
        conn._recv_orderbook_snap_subr_at = ws_recv_ts;
        this.subr_latency.push(conn._recv_orderbook_snap_subr_at - conn._sent_orderbook_snap_sub_at);
      }
      _info.is_subscribed = true;
      if (!this.silent_mode) console.log('[!] ('+conn._idx+') Successfully subscribed to orderbook snapshot updates.');

      // If 'not_handle_trades' or 'info.trades.is_subscribed' resolve the promise.
      if (_prom && 
      (_ws.not_handle_trades === true || conn.info.trades?.is_subscribed) ||
      (_ws.subcriptions.orderbook == null || conn.info.orderbook?.is_subscribed))
        _prom.resolve();
    }
  }

  format_orderbook_msg (msg, _ws, __ws, _prom, conn, is_snap = false) {
    // This function must receive the 'orderbook' message and format it to the pattern below.
    // {
    //   asks: [ [ price, amount ], ... ],
    //   bids: [ [ price, amount ], ... ],
    //   timestamp: <timestamp in miliseconds>,
    //   is_snapshot: <true | false>,
    //   first_update_nonce: <upd nonce here>, *only if required.
    //   last_update_nonce: <upd nonce here>, *only if required.
    // }
    // console.log('Book msg:',msg);

    const _ob_sub = _ws.subcriptions[ is_snap ? 'orderbook_snap' : 'orderbook' ];
    const _info = conn.info[ is_snap ? 'orderbook_snap' : 'orderbook' ];

    // Checks if its the first update.
    if (_info.received_first_update !== true) {
      _info.received_first_update = true;
      
      // Ignore the first update if needed.
      if (_ob_sub.update.ignore_first_update === true) return null;
    }
    
    // Check if channel message should be ignored ('ignore_if').
    for (const [ key, value ] of (_ob_sub.update.ignore_if || [])) {
      if (msg[key] === value) return null;
    }

    // Handle 'data_inside'.
    msg = (_ob_sub.update.data_inside?.split('.')?.reduce((f, k) => f?.[k], msg) || msg);

    // Define if this orderbook message is an updade or a snapshot.
    let is_snapshot = is_snap;
    if (!is_snapshot) {
      const _id_val = _ob_sub.snapshot?.identifier_key?.split('.')?.reduce((f, k) => f?.[k], msg);
      is_snapshot = (_id_val != undefined && (
        _ob_sub.snapshot?.identifier_value == undefined || 
        _id_val == _ob_sub.snapshot?.identifier_value
      ));
    }

    // Checks if orderbook have already received first update.
    if (conn.info.orderbook._received_first_update !== true) {
      conn.info.orderbook._received_first_update = true;
      
      // Checks if the first update should be handled as snaphot and updates 'is_snapshot' acordly.
      if (_ob_sub.snapshot?.its_first_update === true)
        is_snapshot = true;
    }
    
    // Builds the formatted message.
    let updates = (_ob_sub.update.updates_inside?.split('.')?.reduce((f, k) => f?.[k], msg) || msg);
    let asks = [];
    let bids = [];
    // let timestamps = [];
    let higher_timestamp = null;

    if ((is_snapshot && _ob_sub.snapshot?.asks_and_bids_together) || 
    ((!is_snapshot) && _ob_sub.update?.asks_and_bids_together)) {
      for (const upd of updates) {
        const _pl =  ((is_snapshot && _ob_sub.snapshot?.pl) || _ob_sub.update.pl);
        
        const _ts = _pl?.timestamp?.split('.')?.reduce((f, k) => f?.[k], upd);
        if (_ts != undefined) {
          let formatted_ts = this.format_timestamp(_ts, _ob_sub.update);
          if (higher_timestamp == null || Big(formatted_ts).gt(higher_timestamp.formatted_ts))
            higher_timestamp = { formatted_ts, upd };
        }

        let price = _pl.price?.split('.')?.reduce((f, k) => f?.[k], upd);
        let amount = _pl.amount?.split('.')?.reduce((f, k) => f?.[k], upd);
        let is_bids = undefined;

        if (_pl.is_bids_key != undefined) {
          const _val = _pl.is_bids_key?.split('.')?.reduce((f, k) => f?.[k], upd);
          is_bids = (_val != undefined && (_pl.is_bids_value == undefined || _val == _pl.is_bids_value));

        } else if (_ob_sub.update.is_bids_positive_amount) {
          is_bids = Big(amount).gt(0);
          amount = Big(amount).abs().toFixed();

        } else {
          const _type = (is_snapshot && _ob_sub.snapshot?.pl) ? "snapshot" : "update";
          if (_prom) {
            _prom.reject({ 
              At: "Parsing orderbook update message:", 
              error: "Neither 'orderbook."+_type+".pl.is_bids_key' or 'orderbook.update.is_bids_positive_amount' are defined." 
            });
          } else {
            console.log("[E] Parsing orderbook update message: \
            Neither 'orderbook."+_type+".pl.is_bids_key' or 'orderbook.update.is_bids_positive_amount' are defined.\
            \n\nEnding connection...");
            __ws.terminate();
          }
          return;
        }

        if (_pl.to_remove_key != undefined) {
          const _val = _pl.to_remove_key?.split('.')?.reduce((f, k) => f?.[k], upd);
          if (_val != undefined && (_pl.to_remove_value == undefined || _val == _pl.to_remove_value))
            amount = '0';
        }

        if (is_bids)
          bids.push([ Big(price).toFixed(), Big(amount).toFixed() ]);
        else
          asks.push([ Big(price).toFixed(), Big(amount).toFixed() ]);
      }
    } else {
      asks = (updates[(is_snapshot && _ob_sub.snapshot?.asks) || _ob_sub.update.asks] || [])
      .map(upd => {
        const _key = (is_snapshot && _ob_sub.snapshot?.pl?.timestamp) || _ob_sub.update.pl?.timestamp;
        const _ts = _key?.split('.')?.reduce((f, k) => f?.[k], upd);
        if (_ts != undefined) {
          let formatted_ts = this.format_timestamp(_ts, _ob_sub.update);
          if (higher_timestamp == null || Big(formatted_ts).gt(higher_timestamp.formatted_ts))
            higher_timestamp = { formatted_ts, upd };
        }

        return [ 
          Big(upd[(is_snapshot && _ob_sub.snapshot?.pl?.price) || _ob_sub.update.pl.price]).toFixed(), 
          Big(upd[(is_snapshot && _ob_sub.snapshot?.pl?.amount) || _ob_sub.update.pl.amount]).toFixed()
        ]
      });
      
      bids = (updates[(is_snapshot && _ob_sub.snapshot?.bids) || _ob_sub.update.bids] || [])
      .map(upd => {
        const _key = (is_snapshot && _ob_sub.snapshot?.pl?.timestamp) || _ob_sub.update.pl?.timestamp;
        const _ts = _key?.split('.')?.reduce((f, k) => f?.[k], upd);
        if (_ts != undefined) {
          let formatted_ts = this.format_timestamp(_ts, _ob_sub.update);
          if (higher_timestamp == null || Big(formatted_ts).gt(higher_timestamp.formatted_ts))
            higher_timestamp = { formatted_ts, upd };
        }

        return [ 
          Big(upd[(is_snapshot && _ob_sub.snapshot?.pl?.price) || _ob_sub.update.pl.price]).toFixed(), 
          Big(upd[(is_snapshot && _ob_sub.snapshot?.pl?.amount) || _ob_sub.update.pl.amount]).toFixed() 
        ]
      });
    }

    let formatted = { asks, bids, is_snapshot };

    // Define the timestamp.
    if (_ob_sub.update.timestamp || _ob_sub.snapshot?.timestamp) {
      const _key = (is_snapshot && _ob_sub.snapshot?.timestamp) || _ob_sub.update.timestamp;
      const _ts = _key?.split('.')?.reduce((f, k) => f?.[k], msg) || _key?.split('.')?.reduce((f, k) => f?.[k], updates);
      formatted.timestamp = this.format_timestamp(_ts, _ob_sub.update);

      // Try to define 'timestamp_us'.
      if (is_snapshot) {
        if (_ob_sub.snapshot?.get_timestamp_us_from_iso) {
          formatted.timestamp_us = new Date(_ts).getTime() + _ts.slice(23, -1);
        } else if (this.exc.timestamp_in_micro || _ob_sub.snapshot?.timestamp_in_micro) {
          formatted.timestamp_us = _ts;
        }
      } else {
        if (_ob_sub.update?.get_timestamp_us_from_iso) {
          formatted.timestamp_us = new Date(_ts).getTime() + _ts.slice(23, -1);
        } else if (this.exc.timestamp_in_micro || _ob_sub.update?.timestamp_in_micro) {
          formatted.timestamp_us = _ts;
        }
      }

    } else if (higher_timestamp != null) {
      formatted.timestamp = higher_timestamp.formatted_ts;

      // Try to define 'timestamp_us'.
      const _pl =  ((is_snapshot && _ob_sub.snapshot?.pl) || _ob_sub.update.pl);
      const _ts = _pl?.timestamp?.split('.')?.reduce((f, k) => f?.[k], higher_timestamp.upd);
      if (is_snapshot) {
        if (_ob_sub.snapshot?.get_timestamp_us_from_iso) {
          formatted.timestamp_us = new Date(_ts).getTime() + _ts.slice(23, -1);
        } else if (this.exc.timestamp_in_micro || _ob_sub.snapshot?.timestamp_in_micro) {
          formatted.timestamp_us = _ts;
        }
      } else {
        if (_ob_sub.update?.get_timestamp_us_from_iso) {
          formatted.timestamp_us = new Date(_ts).getTime() + _ts.slice(23, -1);
        } else if (this.exc.timestamp_in_micro || _ob_sub.update?.timestamp_in_micro) {
          formatted.timestamp_us = _ts;
        }
      }

    } else {
      // Neighter 'update/snapshot.timestamp' or 'update/snapshot.pl.timestmap' defined.
      const _type = (is_snapshot && _ob_sub.snapshot) ? "snapshot" : "update";
      if (_prom) {
        _prom.reject({ 
          At: "Parsing orderbook update message:", 
          error: "Neither 'orderbook."+_type+".timestamp' or 'orderbook."+_type+".pl.timestamp' are defined." 
        });
      } else {
        console.log("[E] Parsing orderbook update message: \
        Neither 'orderbook."+_type+".timestamp' or 'orderbook."+_type+".pl.timestamp' are defined.\
        \n\nEnding connection...");
        __ws.terminate();
      }
      return;
    }

    // Set 'first_update_nonce' if possible.
    if (_ob_sub.update.first_upd_nonce_key)
      formatted.first_update_nonce = (msg[_ob_sub.update.first_upd_nonce_key] || updates[_ob_sub.update.first_upd_nonce_key]);
    else if (_ob_sub.update.prev_upd_nonce_key)
      formatted.first_update_nonce = (msg[_ob_sub.update.prev_upd_nonce_key] || updates[_ob_sub.update.prev_upd_nonce_key]) * 1 + 1;

    // Set 'last_update_nonce' if possible.
    if (_ob_sub.update.last_upd_nonce_key)
      formatted.last_update_nonce = (msg[_ob_sub.update.last_upd_nonce_key] || updates[_ob_sub.update.last_upd_nonce_key]);
    
    // Returns the formatted message.
    return formatted;
  }

  handle_orderbook_msg (update, _ws, __ws, _prom, ws_recv_ts) {
    if (update == null) return; // Ignore.

    if (update.is_snapshot) {
      this.apply_orderbook_snap(update, __ws, _prom, ws_recv_ts);

    } else {
      if (this.orderbook == null) {
        // Just cache update.
        
        // if (this.orderbook_upd_cache.length == 0)
        //   console.log('[!!] Got first orderbook update at',update.timestamp);

        this.orderbook_upd_cache.push(update);
  
      } else {
        // Just apply update.
        this.apply_orderbook_upd(update, __ws, _prom, ws_recv_ts);
      }
    }
  }

  before_apply_to_orderbook (upd_time) {
    const upd_sec = Math.floor(upd_time / 1e3);
    const book_sec = Math.floor(this.orderbook?.timestamp / 1e3);

    if (this.orderbook != null && (
      this.delayed_orderbook == null || 
      Math.floor(this.orderbook.timestamp / 1e3) != Math.floor(upd_time / 1e3)
    )) {
      const save_it = (this.delayed_orderbook != null);

      if (save_it && this.delayed_orderbook.first && this.delayed_orderbook.timestamp != undefined && 
      Math.floor(this.delayed_orderbook.timestamp / 1e3) != Math.floor(this.orderbook.timestamp / 1e3))
        this.orderbooks.unshift(this.delayed_orderbook);

      this.delayed_orderbook = {
        asks: Object.entries(this.orderbook.asks).sort((a, b) => Big(a[0]).cmp(b[0])).slice(0, this.orderbook_depth),
        bids: Object.entries(this.orderbook.bids).sort((a, b) => Big(b[0]).cmp(a[0])).slice(0, this.orderbook_depth),
        timestamp: this.orderbook.timestamp,
        first: !save_it
      };

      if (save_it && this.delayed_orderbook.timestamp != undefined) {
        this.orderbooks.unshift(this.delayed_orderbook);

        // Check if is time to save orderbooks and trades of the last 'half-hour' to AWS S3.
        if (this.completely_synced && upd_sec % this.seconds_to_export == 0) {
          // Set up 'this.seconds_data'.
          while (this.data_time <= upd_sec) this.save_second();
          
          // Reset 'trades' and 'orderbooks' vars.
          this.trades = [];
          this.orderbooks = [];
          
          // Save 'this.seconds_data' to AWS S3 and reset it.
          this.save_to_s3();
        }
      }
    }
  }

  apply_orderbook_snap (update, __ws, _prom, ws_recv_ts) {
    // Validate snapshot update.
    // console.log('Book snap:',update);
    // console.log('snap upd:',(update.last_update_nonce || update.timestamp_us || update.timestamp), (update.last_update_nonce && "last_update_nonce") || (update.timestamp_us && "timestamp_us") || (update.timestamp && "timestamp"));
    if (this.orderbook != null && (
      (this.orderbook.last_update_nonce && update.last_update_nonce && Big(update.last_update_nonce).lte(this.orderbook.last_update_nonce)) ||
      (this.orderbook.timestamp_us && update.timestamp_us && Big(update.timestamp_us).lt(this.orderbook.timestamp_us)) ||
      (this.orderbook.timestamp && update.timestamp && Big(update.timestamp).lt(this.orderbook.timestamp))
    ))
      return; // console.log(((this.orderbook == null && 'nada') || this.orderbook.last_update_nonce || this.orderbook.timestamp_us || this.orderbook.timestamp),'false\n');

    // console.log(((this.orderbook == null && 'nada') || this.orderbook.last_update_nonce || this.orderbook.timestamp_us || this.orderbook.timestamp),'true\n')

    if (this.is_lantecy_test && update.timestamp) this.diff_latency.push(ws_recv_ts - update.timestamp);

    // Updates 'delayed_orderbook' if its the case.
    this.before_apply_to_orderbook(update.timestamp);

    // if (!this.orderbook) 
    //   console.log('[!!] Got first orderbook snapshot from',((this.exc.rest?.endpoints?.orderbook != null) ? "REST" : "WS"),'at',update.timestamp);

    this.orderbook = {
      asks: Object.fromEntries(update.asks),
      bids: Object.fromEntries(update.bids),
      timestamp: update.timestamp,
      timestamp_us: update.timestamp_us,
      last_update_nonce: update.last_update_nonce
    };

    // Apply cached orderbook updates.
    while (this.orderbook_upd_cache.length > 0) {
      this.apply_orderbook_upd(this.orderbook_upd_cache[0], __ws, _prom, ws_recv_ts);
      this.orderbook_upd_cache.shift();
    }
  }

  apply_orderbook_upd (upd, __ws, _prom, ws_recv_ts) {
    // Validate updates.
    // console.log('Book upd:',upd);
    if ((this.orderbook.last_update_nonce && Big(upd.last_update_nonce).lte(this.orderbook.last_update_nonce)) ||
    (this.orderbook.timestamp_us && upd.timestamp_us && Big(upd.timestamp_us).lt(this.orderbook.timestamp_us)) ||
    (this.orderbook.timestamp && upd.timestamp && Big(upd.timestamp).lt(this.orderbook.timestamp)))
      return; // console.log(((this.orderbook == null && 'nada') || this.orderbook.last_update_nonce || this.orderbook.timestamp_us || this.orderbook.timestamp),'false\n');

    // console.log(((this.orderbook == null && 'nada') || this.orderbook.last_update_nonce || this.orderbook.timestamp_us || this.orderbook.timestamp),'true\n');

    if (this.is_lantecy_test) this.diff_latency.push(ws_recv_ts - upd.timestamp);

    if (upd.first_update_nonce) {
      if (this.orderbook.received_first_update) {
        if (upd.first_update_nonce != this.orderbook.last_update_nonce + 1) {
          const _at = 'apply_orderbook_upd:';
          const _error = 'upd.first_update_nonce ('+upd.first_update_nonce+') <= != orderbook.last_update_nonce + 1 ('+(this.orderbook.last_update_nonce + 1)+').';

          if (_prom) {
            _prom.reject({ At: _at, error: _error });
          } else {
            console.log('[E]',_at,_error,'\n\nEnding connection...');
            __ws.terminate();
          }
          return;
        }
      } else {
        if (upd.first_update_nonce > this.orderbook.last_update_nonce + 1) {
          const _at = 'apply_orderbook_upd:';
          const _error = 'upd.first_update_nonce ('+upd.first_update_nonce+') > orderbook.last_update_nonce + 1 ('+(this.orderbook.last_update_nonce + 1)+').';

          if (_prom) {
            _prom.reject({ At: _at, error: _error });
          } else {
            console.log('[E]',_at,_error,'\n\nEnding connection...');
            __ws.terminate();
          }
          return;
        }
      }
    }

    // Updates 'delayed_orderbook' if its the case.
    this.before_apply_to_orderbook(upd.timestamp);

    // Apply updates.
    for (const side of [ 'asks', 'bids' ]) {
      for (const [ price, amount ] of upd[side]) {
        if (Big(amount).eq(0)) {
          delete this.orderbook[side][price];
        } else {
          this.orderbook[side][price] = amount;
        }
      }
    }
    
    // Update orderbook vars.
    this.orderbook.received_first_update = true;
    this.orderbook.timestamp = upd.timestamp;
    this.orderbook.timestamp_us = upd.timestamp_us;
    this.orderbook.last_update_nonce = upd.last_update_nonce;
  }

  async _connect (conn_idx) {
    // If connection not null returns the connection promise.
    if (this.connections[conn_idx]) return this.connections[conn_idx].main_prom;
    
    this.connections[conn_idx] = { info: {} };  // Create the connection object.
    let conn = this.connections[conn_idx];      // Create a reference to the connection object.
    conn._idx = conn_idx;

    // Create the connection main promise and a control variable to it.
    let main_prom_funcs;
    conn.main_prom = new Promise((resolve, reject) => main_prom_funcs = { resolve, reject }).finally(() => main_prom_funcs = null);
    
    // If there is an 'attemp delay' to this connection waits the delay.
    if (this.attemp_delay[conn_idx]) await this.attemp_delay[conn_idx];

    let _min_promises = [];
    for (const __idx in (this.exc.ws2 ? [ this.exc.ws, this.exc.ws2 ] : [ this.exc.ws ])) {
      const is_secondary = (__idx == '1');
      const _ws = is_secondary ? this.exc.ws2 : this.exc.ws;
      const _ws_type = (is_secondary ? "secondary" : "primary");

      // Check if this connection will handle orderbook updates.
      if (_ws.not_handle_orderbook !== true) {
        // // Reset initial orderbook vars.
        // this.orderbook = null;
        // this.orderbook_upd_cache = [];
        conn.info.orderbook = {};
        conn.info.orderbook_snap = {};
        
        // If no 'orderbook.response', 'info.orderbook.channel_id' should be defined here.
        if (_ws.subcriptions?.orderbook != undefined && _ws.subcriptions.orderbook?.response == undefined) 
          conn.info.orderbook.channel_id = _ws.subcriptions.orderbook.update.channel_id.replaceAll('<market>', this.market.ws);
      }
      
      // Check if this connection will handle trades updates.
      if (_ws.not_handle_trades !== true) { 
        // // Reset initial trades vars.
        // this.trades = null;
        // this.trades_upd_cache = [];
        conn.info.trades = {};
        
        // If no 'trades.response', 'info.trades.channel_id' should be defined here.
        if (_ws.subcriptions?.trades != undefined && _ws.subcriptions.trades?.response == undefined) 
          conn.info.trades.channel_id = _ws.subcriptions.trades?.update?.channel_id.replaceAll('<market>', this.market.ws);
      }
      
      // Create an control var and a promise to indicate if we have succeed on the websocket connection.
      let _prom = null;
      _min_promises.push(
        Promise.race([
          new Promise((resolve, reject) => setTimeout(reject, _ws.timeout || 15000, "TIMEOUT.")),
          new Promise((resolve, reject) => _prom = { resolve, reject }).finally(() => _prom = null)
        ])
      );

      // Checks if websocket conection require any preparation before connection.
      if (this.exc.rest.endpoints?.prepare_for_ws != undefined) {
        let { success, response: r } = await this.rest_request('prepare_for_ws');
        if (!success) _prom.reject({ At:'[E] Connecting to exchange '+_ws_type+' WebSocket:', error: r });
    
        const _r_info = this.exc.rest.endpoints.prepare_for_ws.response;
    
        const _ws_token = _r_info.ws_token_key?.split('.')?.reduce((f, k) => f?.[k], r);
        if (_ws_token != undefined) _ws.token = _ws_token;
    
        const _ws_url = _r_info.ws_url_key?.split('.')?.reduce((f, k) => f?.[k], r);
        if (_ws_url != undefined) _ws.url = _ws_url + "?token=<ws_token>";
    
        if (_ws.ping != undefined) {
          const _ws_ping_interval = _r_info.ws_ping_interval_key?.split('.')?.reduce((f, k) => f?.[k], r);
          if (_ws_ping_interval != undefined) _ws.ping.interval = _ws_ping_interval;
        }
      }

      // Define the endpoint to use, if more than 1.
      let _ws_conn_url = Array.isArray(_ws.url) ? _ws.url[this._url_nonce++ % _ws.url.length] : _ws.url;

      // Creates the WebSocket connection.
      this.connection_tries.push(Date.now());
      const _conn_start_ts = Date.now();
      conn[_ws_type == "primary" ? "ws" : "ws2"] = new WebSocket(
        _ws_conn_url
        .replaceAll('<market>', this.market.ws)
        .replace('<ws_token>', _ws.token)
      );
      const __ws = conn[_ws_type == "primary" ? "ws" : "ws2"];
      
      // Create control vars for a 'ping loop'.
      __ws.keep_alive = true;

      // Create control vars for a 'ws ping loop'.
      __ws.ws_keep_alive = true;

      // When receive a ping, pong back.
      __ws.on('ping', __ws.pong);

      // While we receive 'pong', keep the connection open.
      __ws.on('pong', () => {
        __ws.keep_alive = true; 
      });

      // On disconnection reset vars.
      __ws.on('close', () => {
        if (!this.silent_mode) console.log('[!] WebSocket '+_ws_type+' connection '+conn_idx+' is closed.');

        clearInterval(__ws.ping_loop_interval);
        clearInterval(__ws.ws_ping_loop_interval);

        this.connections[conn_idx] = null;

        if (this.__working == false || this.connections.every(conn => !conn)) {
          // All connections are closed.
          this.completely_synced = false;

          // Reset global variables.
          clearTimeout(this.process_second_timeout);
          this.seconds_data = [];
          this.markets = null;
          this.orderbook = null;
          this.orderbook_upd_cache = [];
          // this.orderbooks = [];
          this.delayed_orderbook = null;
          // this.trades = null;
          this.trades_upd_cache = [];
          this.synced_trades_since = null;
          this.ws_req_nonce = 0;
          this.saved_first_second = false;

        } else {
          // Only this connection has ended, try reconnection respecting the established attempt limits.
          
          // Filter 'connection_tries' to only tries that happened on the last minute.
          this.connection_tries = this.connection_tries.filter(ts => ts >= Date.now() - 60e3);

          // Checks if the number of connetion attemps in the last minute is greater then 'max_attemps_per_min'.
          if (this.connection_tries.length > this.max_attemps_per_min) {
            // In this case we should wait 'conn_attemp_delay' before the connection.
            this.attemp_delay[conn_idx] = (async () => {
              await new Promise(r => setTimeout(r, this.conn_attemp_delay));
              delete this.attemp_delay[conn_idx];
            })();
          }

          this.connect(conn_idx);
        }
      });

      // On WebSocket error, we log the error and then diconnect.
      __ws.on('error', error => {
        console.log('[E] WebSocket '+_ws_type+' connection error:',error);
        __ws.terminate();
      });

      // On connection, initiate 'ping loops', login and then make subscriptions.
      __ws.on('open', () => {
        if (this.is_lantecy_test) {
          const _conn_opened_ts = Date.now();
          this.conn_latency.push(_conn_opened_ts - _conn_start_ts);
        }
        if (!this.silent_mode) console.log('[!] ('+conn._idx+') Connected to '+_ws_type+' WebSocket.');

        // Initiate 'ping loop'.
        __ws.ping_loop_interval = setInterval(() => {
          if (!__ws.keep_alive) {
            console.log('[E] WebSocket '+_ws_type+' ping_loop: Server did not pong back in '+((_ws.timeout || 5000) / 1e3)+' seconds, ending connection...');
            __ws.terminate();
          }
          __ws.keep_alive = false;
          __ws.ping();

          if (_ws.ping?.request != undefined && _ws.ping.response == undefined) // Just ping and do not wait for response.
            __ws.send(_ws.ping.request);

        }, (_ws.timeout || 5000));

        // Initiate 'ws ping loop'.
        if (_ws.ping?.request != undefined && _ws.ping.response != undefined) {
          __ws.ws_ping_loop_interval = setInterval(() => {
            if (!__ws.ws_keep_alive) {
              console.log('[E] WebSocket '+_ws_type+' ws_ping_loop: Server did not pong back in '+((_ws.ping.interval || _ws.timeout || 5000) / 1e3)+' seconds, ending connection...');
              __ws.terminate();
            }
            __ws.ws_keep_alive = false;
            __ws.send(_ws.ping.request.replace('<ws_req_id>', ++this.ws_req_nonce));

          }, (_ws.ping.interval || _ws.timeout || 5000));
        }

        // Checks if login is required.
        if (_ws.login != undefined) {
          // Send a login request.
          const { signature, sign_nonce } = this.authenticate();
          __ws.send(
            _ws.login.request
            .replace('<api_key>', this.api.key)
            .replace('<api_pass>', this.api.pass)
            .replace('<sign_nonce>', sign_nonce)
            .replace('<signature>', signature)
          );

        } else {
          // If no login is required we can make subscriptions now.
          this.make_subscriptions(__ws, _ws, _prom, conn);
        }
      });

      // On message, we should identify each format and handle each message sent by the server.
      __ws.on('message', async (msg) => {
        const ws_recv_ts = Date.now();
        // Decript message if needed
        if (_ws.gzip_encrypted) msg = await ungzip(msg);

        // Try to JSON parse the mesage.
        try { msg = JSON.parse(msg); } catch (e) { msg = msg.toString(); }

        // console.log('('+conn._idx+') WebSocket '+_ws_type+' message:',msg);

        // Checks if message is an error.
        if (msg?.[_ws.error.key] != undefined && 
        (_ws.error.value == undefined || msg[_ws.error.key] == _ws.error.value) &&
        (_ws.error.value_not == undefined || msg[_ws.error.key] != _ws.error.value_not)) {
          if (_prom) {
            _prom.reject({ At: '[E] ('+conn._idx+') WebSocket '+_ws_type+' error message:', error: msg });
          } else {
            console.log('[E] ('+conn._idx+') WebSocket '+_ws_type+' error message:',msg,'\n\nEnding connection...');
            __ws.terminate();
          }
          
          return;
        }

        // Checks if message is a login response.
        if (_ws.login != undefined && 
        msg[_ws.login.response.id_key] != undefined && 
        (_ws.login.response.id_value == null || msg[_ws.login.response.id_key] == _ws.login.response.id_value)) {
          // Checks if login succeed.
          if (_ws.login.response.success_key == undefined || (
            msg[_ws.login.response.success_key] != undefined && (
              _ws.login.response.success_value == undefined || 
              msg[_ws.login.response.success_key] == _ws.login.response.success_value
            )
          )) {
            if (!this.silent_mode) console.log('[!] WebSocket '+_ws_type+' successfully logged in.');
            this.make_subscriptions(__ws, _ws, _prom, conn);

          } else {
            if (_prom) {
              _prom.reject({ At: '[E] '+_ws_type+' WebSocket failed to login:', error: msg });
            } else {
              console.log('[E] '+_ws_type+' WebSocket failed to login:',msg,'\n\nEnding connection...');
              __ws.terminate();
            }
          }

          return;
        }

        // Checks if message is a 'ws ping loop' response.
        if (_ws.ping?.response != undefined) {
          let _id_value = _ws.ping.response.id?.split('.')?.reduce((f, k) => f = f?.[k], msg);
          if (_id_value != undefined && 
          (_ws.ping.response.id_value == undefined || _id_value == _ws.ping.response.id_value)) {
            __ws.ws_keep_alive = true;
            return;
          }
        }

        // Checks if WebSocket handles 'trades' updates. (If so, handle 'trades' subscription response and updates)
        if (_ws.not_handle_trades !== true && _ws.subcriptions.trades != undefined) {
          // Checks if message is a 'trades' subscription response.
          if ((!conn.info.trades.is_subscribed) && _ws.subcriptions.trades?.request != undefined) {
            let is_trades_subs_resp = false;

            // Checks for the type of response the server should to send.
            if (_ws.subcriptions.trades.response.acum_list) {
              let list_id_val = _ws.subcriptions.trades.response?.list_id_key?.split('.')?.reduce((f, k) => f = f?.[k], msg);

              if (list_id_val != undefined && 
              (_ws.subcriptions.trades.response.list_id_value == null ||
              list_id_val == _ws.subcriptions.trades.response.list_id_value) && 
              (_ws.subcriptions.trades.response.list_inside?.split('.')?.reduce((f, k) => f = f?.[k], msg) || msg).some(
                x => x[_ws.subcriptions.trades.response.id] == _ws.subcriptions.trades.response.id_value
              ))
                is_trades_subs_resp = true;

            } else {
              let id_val = _ws.subcriptions.trades.response.id?.split('.')?.reduce((f, k) => f = f?.[k], msg);
              let object_id_val = _ws.subcriptions.trades.response.object_id_key?.split('.')?.reduce((f, k) => f = f?.[k], msg);

              if (id_val != undefined && id_val == conn.info.trades.req_id &&
              _ws.subcriptions.trades.response.is_object !== true || (
                object_id_val != undefined && (
                  _ws.subcriptions.trades.response.object_id_value == undefined || 
                  object_id_val == _ws.subcriptions.trades.response.object_id_value.replaceAll('<market>', this.market.ws)
                )
              ))
                is_trades_subs_resp = true;
            }

            if (is_trades_subs_resp) return this.handle_trades_sub_resp(msg, _ws, __ws, _prom, conn, ws_recv_ts);
          }
    
          // Checks if message is a 'trades' update message.
          const _id_key = _ws.subcriptions.trades?.update?.channel_id_key;
          let _channel_id = Number.isInteger(_id_key*1) && Big(_id_key).lt(0) ? 
            (Array.isArray(msg) ? msg.slice(_id_key)[0] : undefined) : 
            _id_key?.split('.')?.reduce((f, k) => f = f?.[k], msg);

          if (_channel_id != undefined && (
            _channel_id == conn.info.trades.channel_id ||
            _channel_id == _ws.subcriptions?.trades?.update?.channel_id?.replaceAll('<market>', this.market.ws) // Some exchanges (htx) may sent an update before the subscription response.
          )) {
            // Format and handle data.
            return this.handle_trades_msg(this.format_trades_msg(msg, _ws, __ws, _prom, conn), _ws);
          
          }
        }

        // Checks if WebSocket handles 'orderbook' updates. (If so, handle 'orderbook' and 'orderbook_snap' subscription response and updates)
        if (_ws.not_handle_orderbook !== true) {
          if (_ws.subcriptions.orderbook != undefined) {
            // Checks if message is a 'orderbook' subscription response.
            if ((!conn.info.orderbook.is_upds_subscribed) && _ws.subcriptions.orderbook?.request != undefined) {
              let is_book_subs_resp = false;
              
              // Checks for the type of response the server should to send.
              if (_ws.subcriptions.orderbook.response.acum_list) {
                let list_id_val = _ws.subcriptions.orderbook.response?.list_id_key.split('.')?.reduce((f, k) => f = f?.[k], msg);

                if (list_id_val != undefined && 
                (_ws.subcriptions.orderbook.response.list_id_value == null ||
                list_id_val == _ws.subcriptions.orderbook.response.list_id_value) && 
                (_ws.subcriptions.orderbook.response.list_inside?.split('.')?.reduce((f, k) => f = f?.[k], msg) || msg).some(
                  x => x[_ws.subcriptions.orderbook.response.id] == _ws.subcriptions.orderbook.response.id_value
                ))
                  is_book_subs_resp = true;

              } else {
                let id_val = _ws.subcriptions.orderbook.response.id?.split('.')?.reduce((f, k) => f = f?.[k], msg);
                let object_id_val = _ws.subcriptions.orderbook.response.object_id_key?.split('.')?.reduce((f, k) => f = f?.[k], msg);

                if (id_val != undefined && id_val == conn.info.orderbook.req_id &&
                (_ws.subcriptions.orderbook.response.is_object !== true || (
                  object_id_val != undefined && (
                    _ws.subcriptions.orderbook.response.object_id_value == undefined || 
                    object_id_val == _ws.subcriptions.orderbook.response.object_id_value.replaceAll('<market>', this.market.ws)
                  )
                )))
                  is_book_subs_resp = true;
              }

              // Checks if msg is a response to 'orderbook' subcription.
              if (is_book_subs_resp) {
                // Checks if this response also is the response for 'trades' subcription.
                if (_ws.not_handle_trades !== true && _ws.subcriptions.orderbook.response.include_trades)
                  this.handle_trades_sub_resp(msg, _ws, __ws, _prom, conn, ws_recv_ts);

                this.handle_orderbook_sub_resp(msg, _ws, __ws, _prom, conn, ws_recv_ts);

                // Retuns if messade do not include snapshot, otherwise this message will be further handled as an 'orderbook message'.
                if (!_ws.subcriptions.orderbook.response.include_snapshot) return; 
              }
            }
    
            // Checks if message is a 'orderbook' update/snapshot message.
            const _id_key = _ws.subcriptions.orderbook?.update?.channel_id_key;
            let _channel_id = Number.isInteger(_id_key*1) && Big(_id_key).lt(0) ? 
              (Array.isArray(msg) ? msg.slice(_id_key)[0] : undefined) : 
              _id_key?.split('.')?.reduce((f, k) => f = f?.[k], msg);

            if (_channel_id != undefined && (
              _channel_id == conn.info.orderbook.channel_id ||
              _channel_id == _ws.subcriptions?.orderbook?.update?.channel_id?.replaceAll('<market>', this.market.ws) || // In some cases need to parse an update before the orderbook subscription response.
              _channel_id == _ws.subcriptions?.orderbook?.snapshot?.channel_id?.replaceAll('<market>', this.market.ws)
            )) {
              // Format and handle data.
              const _ob_sub = _ws.subcriptions.orderbook;

              if (_ob_sub.update.data_inside?.includes(',')) {
                msg
                .slice(..._ob_sub.update.data_inside.split(','))
                .forEach(upd_msg => this.handle_orderbook_msg(this.format_orderbook_msg(upd_msg, _ws, __ws, _prom, conn), _ws, __ws, _prom, ws_recv_ts));
                return;
              }
              
              if (_ob_sub.update.data_inside_arr && _ob_sub.update.data_inside_arr_inside) {
                const base_upd = Object.keys(msg).reduce((s, k) => {
                  if (k != _ob_sub.update.data_inside_arr_inside)
                    s[k] = msg[k];
                  return s;
                }, {});

                msg[_ws.subcriptions.orderbook.update.data_inside_arr_inside]
                .forEach(upd_msg => {
                  this.handle_orderbook_msg(this.format_orderbook_msg({ ...base_upd, ...upd_msg }, _ws, __ws, _prom, conn), _ws, __ws, _prom, ws_recv_ts);
                });
                return;
              }

              return this.handle_orderbook_msg(this.format_orderbook_msg(msg, _ws, __ws, _prom, conn), _ws, __ws, _prom, ws_recv_ts);
            }
          }

          if (_ws.subcriptions.orderbook_snap != undefined) {
            // Checks if message is a 'orderbook_snap' subscription response.
            if ((!conn.info.orderbook_snap?.is_upds_subscribed) && _ws.subcriptions.orderbook_snap?.request != undefined) {
              let is_booksnap_subs_resp = false;

              // Checks for the type of response the server should to send.
              if (_ws.subcriptions.orderbook_snap.response.acum_list) {
                let list_id_val = _ws.subcriptions.orderbook_snap.response?.list_id_key.split('.')?.reduce((f, k) => f = f?.[k], msg);

                if (list_id_val != undefined && 
                (_ws.subcriptions.orderbook_snap.response.list_id_value == null ||
                list_id_val == _ws.subcriptions.orderbook_snap.response.list_id_value) && 
                (_ws.subcriptions.orderbook_snap.response.list_inside?.split('.')?.reduce((f, k) => f = f?.[k], msg) || msg).some(
                  x => x[_ws.subcriptions.orderbook_snap.response.id] == _ws.subcriptions.orderbook_snap.response.id_value
                ))
                  is_booksnap_subs_resp = true;

              } else {
                let id_val = _ws.subcriptions.orderbook_snap.response.id?.split('.')?.reduce((f, k) => f = f?.[k], msg);
                let object_id_val = _ws.subcriptions.orderbook_snap.response.object_id_key?.split('.')?.reduce((f, k) => f = f?.[k], msg);

                if (id_val != undefined && id_val == conn.info.orderbook_snap.req_id &&
                (_ws.subcriptions.orderbook_snap.response.is_object !== true || (
                  object_id_val != undefined && (
                    _ws.subcriptions.orderbook_snap.response.object_id_value == undefined || 
                    object_id_val == _ws.subcriptions.orderbook_snap.response.object_id_value.replaceAll('<market>', this.market.ws)
                  )
                )))
                  is_booksnap_subs_resp = true;
              }

              // Checks if msg is a response to 'orderbook_snap' subcription.
              if (is_booksnap_subs_resp) {
                // Checks if this response also is the response for 'trades' subcription.
                if (_ws.not_handle_trades !== true && _ws.subcriptions.orderbook_snap.response.include_trades)
                  this.handle_trades_sub_resp(msg, _ws, __ws, _prom, conn, ws_recv_ts);

                this.handle_orderbook_sub_resp(msg, _ws, __ws, _prom, conn, ws_recv_ts, true);

                // Retuns if msg do not include snapshot, otherwise this message will be further handled as an 'orderbook message'.
                if (!_ws.subcriptions.orderbook_snap.response.include_snapshot) return; 
              }
            }
    
            // Checks if message is a 'orderbook_snap' update message.
            const _id_key = _ws.subcriptions.orderbook_snap?.update?.channel_id_key;
            let _channel_id = Number.isInteger(_id_key*1) && Big(_id_key).lt(0) ? 
              (Array.isArray(msg) ? msg.slice(_id_key)[0] : undefined) : 
              _id_key?.split('.')?.reduce((f, k) => f = f?.[k], msg);

            if (_channel_id != undefined && _channel_id == conn.info.orderbook_snap.channel_id) {
              // Format and handle data.
              return this.handle_orderbook_msg(this.format_orderbook_msg(msg, _ws, __ws, _prom, conn, true), _ws, __ws, _prom, ws_recv_ts);
            }
          }
        }

        // Handle other updates:
        if (_ws?.other_updates != undefined) {
          const updts = Object.values(_ws?.other_updates || {});
          for (const upd of updts) {
            const _id_val = upd.identifier_key?.split('.')?.reduce((f, k) => f?.[k], msg);
            if (_id_val != undefined && 
            (upd.identifier_value == undefined || _id_val == upd.identifier_value)) {
              // Handle the update.
              if (upd.replace_and_respond) {
                let msg_to_respond = JSON.parse(JSON.stringify(msg));
  
                for (const key of (upd.to_delete_from_object || []))
                  delete msg_to_respond[key];
  
                msg_to_respond = JSON.stringify(msg_to_respond)
                .replace(upd.to_replace, upd.replace_with);
  
                __ws.send(msg_to_respond);
                return;
              }
            }
          }
        }
    
        // WebSocket messages to ignore.
        if (_ws?.msgs_to_ignore != undefined &&
        _ws.msgs_to_ignore.some(([ key, value ]) => {
          const _val = key?.split('.')?.reduce((f, k) => f?.[k], msg);
          return (_val != undefined && (value == undefined || _val == value));
        }))
          return; // Should ignore
    
        // Received an unexpected message from the server.
        if (_prom) {
          _prom.reject({ At: '[E] WebSocket '+_ws_type+' unexpected message:', error: msg });
        } else {
          console.log('[E] WebSocket '+_ws_type+' unexpected message:',msg,'\nEnding connection...\n');
        }
        __ws.terminate();
      });
    }

    Promise.all(_min_promises)
    .then(r => main_prom_funcs.resolve(r))
    .catch(e => main_prom_funcs.reject(e));

    return conn.main_prom;
  }

  async connect (conn_idx = null) {
    let conn_proms = []; // Store the connections promises.

    if (conn_idx === null) {
      // Try to open every connection.
      if (!this.silent_mode) console.log('Connecting to '+this.exchange+' '+this.base+'/'+this.quote+'...');
      
      for (let c_idx = 0; c_idx < this.connections_num; ++c_idx) {
        conn_proms.push(this._connect(c_idx));
      }

    } else {
      // Try to open the specyfic connection at 'conn_idx'. 
      conn_proms.push(this._connect(conn_idx));

    }

    return Promise.all(conn_proms);
  }

  async validate_market () {
    // Get exchange 'available_pairs'.
    let { success, response: r } = await this.rest_request('available_pairs', [ [ '<market>', this.market.rest ] ]);
    if (!success) {
      console.log('[E] Getting exchange markets:',r);
      throw 'Initiating synchronization failed to get exchange markets.'
    }

    // If it returns something that is not array, tries to convert it to array.
    if (!Array.isArray(r))
      r = Object.keys(r).reduce((s, k) => [ ...s, { __key: k, ...r[k] } ] , []);

    let raw_markets = r;

    // Set markets by filtering raw active markets.
    this.markets = [];
    const _mkts_r = this.exc.rest.endpoints.available_pairs.response;
    for (const market of raw_markets) {
      if (_mkts_r.status_key == null || (
        market?.[_mkts_r.status_key] != null && (
          _mkts_r.status_active == null ||
          market[_mkts_r.status_key] == _mkts_r.status_active
        )
      ))
        this.markets.push(market[_mkts_r.symbol] || market);
    }

    // Validate market.
    if (!this.markets.includes(this.market.rest))
      throw "Market '"+this.market.rest+"' is not valid or is not active at the moment.";
  }

  async get_trades_snapshot (initiated_at_sec) {
    // Define variable to store the initial snapshot.
    let init_trades = null;

    // Set shorcuts for 'exc' object.
    const _t_ws = this.exc.ws2 != undefined && this.exc.ws2.subcriptions.trades ? this.exc.ws2 : this.exc.ws;
    const _t_ws_upd = _t_ws.subcriptions?.trades?.update;
    const _t_rt_rsp = this.exc.rest.endpoints?.trades?.response;
    
    // 'since' represents the start of the second that we are syncing.
    let since = initiated_at_sec;
    if (!this.exc.timestamp_in_seconds) since *= 1e3;
    
    do {
      // Do not repeat the rest request just beacause we did not receive any ws trade update, instead just wait for 50ms.
      if (init_trades != null && this.trades_upd_cache[0] == undefined) {
        await new Promise(r => setTimeout(r, 50));
      
      } else {
        // Make rest request to get initial trades snapshot.
        let { success, response: r } = await this.rest_request('trades', [
          [ '<market>', this.market.rest ],
          [ '<since>', since ],
          [ '<now>', Date.now() ]
        ]);
        if (!success) {
          console.log('[E] Initial trades snapshot request:',r);
          throw 'Initial trades snapshot request failed.'
        }
        
        // Sort received trades using 'sort_key'.
        if (_t_rt_rsp.sort_key != undefined)
          r.sort((a, b) => Big(a[_t_rt_rsp.sort_key]).cmp(b[_t_rt_rsp.sort_key]));
        
        // Do the trades pagination if possible/needed.
        const _pag = _t_rt_rsp?.pagination;
        if (_pag != undefined) {
          if (_pag.check_for_newer) {
            // Check for newer trades (required when using 'since' parameter and trades reponse have a limit.)
            // loop growing 'page_id' w/ the newest trade timstamp/id until the response length be lower than '_pag.max_arr_size'.
            let resp_len = r.length;
            while (resp_len >= _pag.max_arr_size) {
              if (resp_len > _pag.max_arr_size) // Just in case...
                throw "Initial trades snapshot response length > 'pagination.max_arr_size'";

              let newest_id = (_t_rt_rsp.newer_first ? r[0] : r[r.length - 1])[_pag.page_id];

              // If the pagination is timestamp based, decrease it by 1 for safety.
              if (_pag.page_id == _t_rt_rsp.timestamp) newest_id = Big(newest_id).minus(1).toFixed();
              
              // Make the pagination request.
              let { success, response: r_pag } = await this.rest_request('trades', [
                [ '<market>', this.market.rest ],
                [ '<since>', since ],
                [ '<page_id>', newest_id ],
                [ '<now>', Date.now() ]
              ], true);
              if (!success) {
                console.log('[E] At trades pagination loop (check_for_newer):',r_pag);
                throw "Failed to get all necessary trades.";
              }

              // Sort received trades using 'sort_key'.
              if (_t_rt_rsp.sort_key != undefined)
                r_pag.sort((a, b) => Big(a[_t_rt_rsp.sort_key]).cmp(b[_t_rt_rsp.sort_key]));

              // Concatenate pagination trades.
              r = _t_rt_rsp.newer_first ? [ ...r_pag, ...r ] : [ ...r, ...r_pag ];

              resp_len = r_pag.length; // Updates 'resp_len'.
            }
          } else {
            // Make sure the oldest trade from 'init_trades' is < 'since'.
            // loop reducing 'page_id' w/ the oldest trade timstamp/id until the oldest trade timestamp be lower than 'since'.
            let oldest_trade = _t_rt_rsp.newer_first ? r[r.length - 1] : r[0];
            let oldest_trade_ts = _t_rt_rsp.timestamp.split('.').reduce((f, k) => f?.[k], oldest_trade);
            if (this.exc.timestamp_ISO_format) oldest_trade_ts = new Date(oldest_trade_ts).getTime();
            
            while (Big(oldest_trade_ts).gt(since)) {
              let oldest_id = oldest_trade[_pag.page_id];

              // If the pagination is timestamp based, increase it by 1 for safety.
              if (_pag.page_id == _t_rt_rsp.timestamp) oldest_id = Big(oldest_id).plus(1).toFixed();

              // Make the pagination request.
              let { success, response: r_pag } = await this.rest_request('trades', [
                [ '<market>', this.market.rest ],
                [ '<since>', since ],
                [ '<page_id>', oldest_id ]
              ], true);
              if (!success) {
                console.log('[E] At trades pagination loop (check_for_older):',r_pag);
                throw "Failed to get all necessary trades.";
              }

              // Sort received trades using 'sort_key'.
              if (_t_rt_rsp.sort_key != undefined)
                r_pag.sort((a, b) => Big(a[_t_rt_rsp.sort_key]).cmp(b[_t_rt_rsp.sort_key]));

              // Concatenate pagination trades.
              r = _t_rt_rsp.newer_first ? [ ...r, ...r_pag ] : [ ...r_pag, ...r ]
              
              // Updates 'oldest_trade'.
              oldest_trade = _t_rt_rsp.newer_first ? r[r.length - 1] : r[0];

              // Updates 'oldest_trade_ts'.
              oldest_trade_ts = _t_rt_rsp.timestamp.split('.').reduce((f, k) => f?.[k], oldest_trade);
              if (this.exc.timestamp_ISO_format) oldest_trade_ts = new Date(oldest_trade_ts).getTime();
            }
          }
        }
      
        // Sort, format and remove duplicates from 'r' to 'init_trades';
        init_trades = [];

        for (const t of (_t_rt_rsp.newer_first ? r.reverse() : r)) {
          const _ts = _t_rt_rsp.timestamp?.split('.')?.reduce((f, k) => f?.[k], t);
  
          let obj = {
            timestamp: this.format_timestamp(_ts, _t_rt_rsp),
            is_buy: undefined,
            price: Big(_t_rt_rsp.price?.split('.')?.reduce((f, k) => f?.[k], t)).toFixed(),
            amount: Big(_t_rt_rsp.amount?.split('.')?.reduce((f, k) => f?.[k], t)).toFixed()
          };

          // Try to define 'timestamp_us'.
          if (_t_rt_rsp.get_timestamp_us_from_iso) {
            obj.timestamp_us = new Date(_ts).getTime() + _ts.slice(23, -1);
          } else if (this.exc.timestamp_in_micro || _t_rt_rsp.timestamp_in_micro) {
            obj.timestamp_us = _ts;
          }
  
          if (_t_rt_rsp.is_buy_key != undefined) {
            const is_buy_val = _t_rt_rsp.is_buy_key?.split('.')?.reduce((f, k) => f?.[k], t);
            obj.is_buy = (is_buy_val != undefined && (_t_rt_rsp.is_buy_value == undefined || is_buy_val == _t_rt_rsp.is_buy_value));
  
          } else if (_t_rt_rsp.is_buy_positive_amount === true) {
            obj.is_buy = Big(obj.amount).gt(0);
            obj.amount = Big(obj.amount).abs().toFixed();
            
          } else {
            throw "[E] Formating init_trades: Can't determine trade side."
          }
  
          obj.trade_id = _t_rt_rsp.trade_id_key?.split('.')?.reduce((f, k) => f?.[k], t);
          obj.custom_id = '' + obj.timestamp + obj.is_buy + obj.price + obj.amount;
          
          const _unique_id = (obj.trade_id || obj.custom_id); // "unique"
          if (init_trades.every(it => (it.trade_id || it.custom_id) != _unique_id))
            init_trades.push(obj);
        }
      }

      if (init_trades.length > 0 && 
      this.trades_upd_cache[0] != undefined &&
      Big(this.trades_upd_cache[0].timestamp).gt(init_trades.slice(-1)[0].timestamp) &&
      _t_rt_rsp.slow_cache) {
        // Rest 'trades' request have a slow cache, flooding the API won't help, in this case wait 1 second.
        await new Promise(r => setTimeout(r, (_t_rt_rsp.slow_cache_delay || 1e3)));
      }

      // console.log('this.trades_upd_cache[0]:',this.trades_upd_cache[0]?.timestamp);
      // console.log('init_trades.slice(-1)[0]:',init_trades.slice(-1)[0]?.timestamp);
      // console.log('init_trades[0]:',init_trades[0]?.timestamp,'\n');
    } while (
      init_trades.length > 0 && // If no trades ocurred then it should be considered synchronized.
      (this.trades_upd_cache[0] == undefined ||
      Big(this.trades_upd_cache[0].timestamp).gt(init_trades.slice(-1)[0].timestamp))
    );

    // Set '_synced_trades_since'.
    if (_t_rt_rsp?.pagination) {
      if (this.synced_trades_since == null || Big(initiated_at_sec * 1e3).lt(this.synced_trades_since))
        this.synced_trades_since = initiated_at_sec * 1e3;

    } else if (init_trades.length > 0) {
      if (this.synced_trades_since == null || Big(init_trades[0].timestamp).lt(this.synced_trades_since))
        this.synced_trades_since = init_trades[0].timestamp;

    } else {
      const _time = _t_rt_rsp?.response_time == undefined ? Date.now() : this.format_timestamp(_t_rt_rsp?.response_time?.split('.')?.reduce((f, k) => f?.[k], r), _t_rt_rsp);
      if (this.synced_trades_since == null || Big(_time).lt(this.synced_trades_since))
        this.synced_trades_since = _time;
    }
    
    // console.log('init_trades.slice(-100):',init_trades.slice(-100));
    // console.log('trades_upd_cache (before filter):',this.trades_upd_cache);

    // Removes trades in 'trades_upd_cache' already included in 'init_trades'.
    const _id_key = (_t_rt_rsp.trade_id_key != undefined && _t_ws_upd.trade_id_key != undefined) ? 'trade_id' : 'custom_id';

    if (_t_ws_upd.id_should_be_higher && _id_key == 'trade_id')
      this.trades_upd_cache = this.trades_upd_cache.filter(t =>
        init_trades.length == 0 || Big(t.trade_id).gt(init_trades.slice(-1)[0].trade_id)
      );
    else
      this.trades_upd_cache = this.trades_upd_cache.filter(t => 
        init_trades.every(rt => rt[_id_key] != t[_id_key])
      );

    // console.log('trades_upd_cache (after filter):',this.trades_upd_cache);
    // process.exit();

    // Set trades from 'init_trades' and 'trades_upd_cache'.
    this.trades = [ ...(this.trades || []), ...init_trades, ...this.trades_upd_cache ];
    this.trades_upd_cache = []; // Empties 'trades_upd_cache'.
  }

  async get_orderbook_snapshot () {
    // Define variable to store the initial snapshot.
    let init_orderbook = null;

    // Set shorcuts for 'exc' object.
    const _b_ws = this.exc.ws2 != undefined && this.exc.ws2.subcriptions.orderbook ? this.exc.ws2 : this.exc.ws;
    const _b_ws_upd = _b_ws.subcriptions?.orderbook?.update;
    const _b_rt_rsp = this.exc.rest.endpoints?.orderbook?.response;
    let ws_recv_ts;

    do {
      // Do not repeat the rest request just beacause we did not receive any ws orderbook update, instead just wait for 50ms.
      if (init_orderbook != null && this.orderbook_upd_cache[0] == undefined) {
        await new Promise(r => setTimeout(r, 50));

      } else {
        // Make rest request to get initial orderbook snapshot.
        let { success, response: r } = await this.rest_request('orderbook', [
          [ '<market>', this.market.rest ]
        ]);
        ws_recv_ts = Date.now();
        if (!success) {
          console.log('[E] Initial orderbook snapshot request:',r);
          throw 'Initial orderbook snapshot request failed.'
        }

        // Format orderbook snapshot from 'r' to 'init_orderbook' as an orderbook update.
        const _ts = _b_rt_rsp?.timestamp?.split('.')?.reduce((f, k) => f?.[k], r);
        init_orderbook = {
          asks: _b_rt_rsp.asks?.split('.')?.reduce((f, k) => f?.[k], r)?.slice(0, this.orderbook_depth)?.map(([ p, q ]) => [ Big(p).toFixed(), Big(q).toFixed() ]),
          bids: _b_rt_rsp.bids?.split('.')?.reduce((f, k) => f?.[k], r)?.slice(0, this.orderbook_depth)?.map(([ p, q ]) => [ Big(p).toFixed(), Big(q).toFixed() ]),
          timestamp: this.format_timestamp(_ts, _b_rt_rsp),
          is_snapshot: true,
          last_update_nonce: _b_rt_rsp.last_update_nonce?.split('.')?.reduce((f, k) => f?.[k], r)
        };

        // Try to define 'timestamp_us'.
        if (_b_rt_rsp.get_timestamp_us_from_iso) {
          obj.timestamp_us = new Date(_ts).getTime() + _ts.slice(23, -1);
        } else if (this.exc.timestamp_in_micro || _b_rt_rsp.timestamp_in_micro) {
          obj.timestamp_us = _ts;
        }
      }

      // console.log('this.orderbook_upd_cache[0].last_update_nonce:',this.orderbook_upd_cache[0]?.last_update_nonce);
      // console.log('init_orderbook.last_update_nonce:',init_orderbook.last_update_nonce,'\n');
    } while (
      _b_rt_rsp?.last_update_nonce != undefined &&
      _b_ws_upd?.last_upd_nonce_key != undefined &&
      (this.orderbook_upd_cache[0] == undefined ||
      Big(this.orderbook_upd_cache[0].last_update_nonce).gt(init_orderbook.last_update_nonce))
    );

    // console.log('[!] Book synced.');
    // console.log('init_orderbook:',init_orderbook);

    // Set 'orderbook' from 'init_orderbook'.
    this.apply_orderbook_snap(init_orderbook, null, null, ws_recv_ts);
  }

  save_to_s3 () {
    // Create a name to the file being saved.
    const timestr = new Date((this.data_time - 60*60*3)*1e3).toISOString().slice(0, 16).replaceAll(':', '-');
    const name = `${this.full_market_name.replace(' ', '_')}_${timestr}.json`;

    // Compress data then save it.
    if (!this.is_test) console.log('Compressing and saving data...');
    CompressAndSendBigJSONToS3(name, this.seconds_data)
    .then(() => { if (!this.is_test) console.log('[!] Data saved successfuly.'); })
    .catch(error => console.log('[E] Failed to save data:',error));
    
    // Reset data in memory. 'this.seconds_data'.
    this.seconds_data = [];
  }

  save_second () {
    const trades_to_post = this.trades
      .filter(t => 
        Big(t.timestamp).gt((this.data_time - 1) * 1e3) &&
        Big(t.timestamp).lte(this.data_time * 1e3)
      )
      .map(t => {
        delete t.trade_id;
        delete t.custom_id;
        return t;
      });
  
    const orderbook_to_post = this.orderbooks.find(ob => Big(ob.timestamp).lte(this.data_time * 1e3));
  
    if (orderbook_to_post) {
      const obj = {
        asks: orderbook_to_post?.asks,
        bids: orderbook_to_post?.bids,
        book_timestamp: orderbook_to_post?.timestamp,
        trades: trades_to_post,
        second: this.data_time,
      };

      if (this.is_test)
        console.log(obj); // Just log the object.
      else
        this.seconds_data.push(obj); // Save in memory.

      this.saved_first_second = true;
      
    } else {
      if (!this.saved_first_second) {
        console.log('/!\\ No orderbook to save at '+this.data_time+':');
        console.log('this.orderbook:',this.orderbook?.timestamp);
        console.log('this.delayed_orderbook:',this.delayed_orderbook?.timestamp);
        console.log('this.orderbooks:',this.orderbooks.map(op => op.timestamp),'\n');
      }
    }
  
    ++this.data_time;
  }
  
  async initiate () {
    const initiated_at = Date.now();
    const initiated_at_sec = Math.floor(initiated_at / 1e3);

    // Set 'this.data_time' as the first second we should save the market data if possible.
    this.data_time = initiated_at_sec + 1;

    // Validate user inputs variables.
    if (this.exchange == undefined)
      throw "Initiating synchronization 'exchange' is not defined.";

    if (!Object.keys(exchanges).includes(this.exchange.toLowerCase()))
      throw "Unknow exchange '"+this.exchange+"'.";

    this.exchange = this.exchange.toLowerCase();
    
    if (this.base == undefined)
      throw "Initiating synchronization 'base' is not defined.";
    
    this.base = this.base.toUpperCase();
    
    if (this.quote == undefined)
      throw "Initiating synchronization 'quote' is not defined.";
    
    this.quote = this.quote.toUpperCase();

    // Sets 'exc'.
    this.exc = exchanges[this.exchange];

    // Sets 'full_market_name'.
    const _base = this.exc?.asset_translation?.[this.base] || this.base;
    const _quote = this.exc?.asset_translation?.[this.quote] || this.quote;
    this.full_market_name = `${this.exchange} ${_base}-${(_quote)}`;

    // Checks if authentication necesary.
    const _auth = (this.exc.ws?.auth || this.exc.rest?.auth);
    if (_auth != undefined && this.authenticate == null) {
      // Sets credentials through environment variables.
      this.api.key = process.env[this.exchange.toUpperCase()+'_API_KEY'];
      this.api.scr = process.env[this.exchange.toUpperCase()+'_API_SECRET'];
      this.api.pass = process.env[this.exchange.toUpperCase()+'_API_PASSPHRASE'];

      // Sets 'authenticate'.
      this.authenticate = function (path = '', body = '') {
        let nonce = eval(_auth.nonce_to_eval);

        let message = _auth.message
          .replace('<nonce>', nonce)
          .replace('<path>', path)
          .replace('<body>', body);

        let signature = crypto.createHmac(
          _auth.algo, 
          _auth.secret_buffer_from != undefined ? Buffer.from(this.api.scr, _auth.secret_buffer_from) : this.api.scr
        )
        .update(message)
        .digest(_auth.digest_to);

        let to_return  = { signature, sign_nonce: nonce };

        if (_auth.encode_sign_pass) {
          let encoded_pass = crypto.createHmac(
            _auth.algo,
            _auth.secret_buffer_from != undefined ? Buffer.from(this.api.scr, _auth.secret_buffer_from) : this.api.scr
          )
          .update(this.api.pass)
          .digest(_auth.digest_to);
  
          to_return = { ...to_return, encoded_pass };
        }
  
        return to_return;
      };

      // Checks if 'authentication headers' are required.
      const _auth_headers = this.exc.rest.auth?.headers;
      if (_auth_headers != undefined) {
        // Sets 'get_auth_headers'.
        this.get_auth_headers = function (path = '', body = '') {
          const { signature, sign_nonce, encoded_pass } = this.authenticate(path, body);
          let headers = {};
          
          if (_auth_headers?.signature != undefined)
            headers[_auth_headers.signature] = signature;

          if (_auth_headers?.nonce != undefined)
            headers[_auth_headers.nonce] = this.exc.rest.auth.is_nonce_header_str ? ''+sign_nonce : sign_nonce;
          
          if (_auth_headers?.api_key != undefined)
            headers[_auth_headers.api_key] = this.api.key;
          
          if (_auth_headers?.api_pass != undefined)
            headers[_auth_headers.api_pass] = (encoded_pass || this.api.pass);
          
          if (_auth_headers?.extras != undefined)
            _auth_headers.extras.forEach(([k, v]) => headers[k] = v);

          return headers;
        }
      }
    }

    // Sets 'market'.
    if (this.exc.separator != undefined) {
      this.exc.rest.separator = this.exc.separator;
      this.exc.ws.separator = this.exc.separator;
    }
    
    if (this.exc.is_market_upper){
      this.exc.rest.is_market_upper = true;
      this.exc.ws.is_market_upper = true;
    }

    this.market = {
      rest: this.base + this.exc.rest.separator + this.quote,
      ws: this.base + this.exc.ws.separator + this.quote
    }

    if (this.exc.rest.is_market_upper)
      this.market.rest = (this.exc.makert_prefix || "") + (this.market.rest.toUpperCase());
    else
      this.market.rest = (this.exc.makert_prefix || "") + (this.market.rest.toLowerCase());
  
    if (this.exc.ws.is_market_upper)
      this.market.ws = (this.exc.makert_prefix || "") + (this.market.ws.toUpperCase());
    else
      this.market.ws = (this.exc.makert_prefix || "") + (this.market.ws.toLowerCase());
    
    let initial_proms = [
      this.connect(),
      this.validate_market()
    ];

    // Try to make the initial 'trades' request.
    // (proceed only when last snapshot trade (timestamp) <= first trade in 'trades_upd_cache')
    if (this.exc.rest.endpoints?.trades != undefined) {
      initial_proms.push(this.get_trades_snapshot(initiated_at_sec));
    } else {
      if (!this.trades) this.trades = [];
    }

    // Try to make an initial request for the orderbook snapshot, if necessary.
    // (proceed only when orderbook snapshot (last_update_nonce) <= first update in 'orderbook_upd_cache')
    if (this.exc.rest.endpoints?.orderbook != undefined) {
      initial_proms.push(this.get_orderbook_snapshot());
    }

    // Try to connect with websocket and subscribe to market updates.
    try {
      await Promise.all(initial_proms);
    } catch (error) {
      console.log("[E] Initiating synchronization:",error);

      for (const conn of this.connections) {
        if ((conn?.ws?.readyState || WebSocket.CLOSED) != WebSocket.CLOSED)
          conn.ws.terminate();

        if ((conn?.ws2?.readyState || WebSocket.CLOSED) != WebSocket.CLOSED)
          conn.ws2.terminate();
      }

      throw "Failed to synchronize with the exchange";
    }

    this.completely_synced = true;
    console.log('[!] Completely synchronized.\n');

    this.keep_synced();
  }

  async keep_synced () {
    if (this.already_keeping_sync) return;
    this.already_keeping_sync = true;

    while (this.__working) {
      if (!this.completely_synced) {
        console.log('Not completely synced, initiating againg...');
        await this.initiate()
        .catch(error => {
          console.log('Failed to initate synchronization:',error);
          console.log('Trying again...');
        });
      }
      await new Promise(r => setTimeout(r, 250)); // Waits 250ms beteen each loop cycle.
    }
  }

  async end () {
    // Stop re-connection.
    this.__working = false;

    // Stop 'ever_second' loop
    clearTimeout(this.process_second_timeout);

    // Close all connections
    for (let c_idx = 0; c_idx < this.connections_num; ++c_idx) {
      const conn = this.connections[c_idx];
      if (conn?.ws && conn.ws.readyState != WebSocket.CLOSED) conn.ws.terminate();
      if (conn?.ws2 && conn.ws2.readyState != WebSocket.CLOSED) conn.ws2.terminate();
    }

    // Reset global vars
    this.completely_synced = false;
    this.orderbook = null;
    this.orderbook_upd_cache = [];
    this.orderbooks = [];
    this.delayed_orderbook = null;
    this.trades = null;
    this.trades_upd_cache = [];
    this.synced_trades_since = null;
    this.ws_req_nonce = 0;
    this.connections = [];
    this.connections_num = 3;
    this.attemp_delay = {}; 
  }
}

export default Synchronizer;