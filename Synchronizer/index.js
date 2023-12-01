import WebSocket from 'ws';
import Big from 'big.js';
import fetch from 'node-fetch';
import crypto from 'crypto';
import exchanges from './Exchanges/index.js';
import dotenv from 'dotenv';
dotenv.config();

// Commonjs importing 
import pkg from 'node-gzip';
const { ungzip } = pkg;

let args = process.argv.slice(2); // Get command-line arguments, starting from index 2

// Set the default 'delay_time_in_seconds' to 1.
if (args.length === 3) args.push(1);

if (args.length !== 4) {
  console.log("Usage: npm sync <exchange> <base> <quote> <delay_time_in_seconds>(optional, default= 3)");
  process.exit(1);
}

let exchange = args[0];
let base = args[1];
let quote = args[2];
const delay_time_in_seconds = args[3];

let markets = null;
let info = { }; // Will store orderbook and trades websocket information.

let orderbook = null;
let orderbook_upd_cache = [];

let orderbooks = [];
let delayed_orderbook = null; // Will store the delayed and simplified version of orderbook.

let trades = null;
let trades_upd_cache = [];

let exc = null;
let api = {};
let market = {};
let ws_req_nonce = 0;
let authenticate = null;
let get_auth_headers = null;

let ws = null; // Will handle WebSocket connection.
let completely_sync = false;

async function rest_request (endpoint, url_replaces = [], is_pagination = false) {
  try {
    const _endpoint = exc.rest.endpoints[endpoint];
    const resp_info = _endpoint?.response;

    let url = (exc.rest.url + _endpoint.path);
    let headers = {};

    if (is_pagination) {
      url += (_endpoint?.pagination?.to_add_url || '');
      url = url.replace((_endpoint?.pagination?.to_del_url || ''), '');
    }

    for (const [ url_code, value ] of url_replaces)
      url = url.replaceAll(url_code, value);

    if (_endpoint.require_auth)
      headers = { ...headers, ...get_auth_headers(url.replace(exc.rest.url, '')) };

    let r = await Promise.race([
      new Promise((res, rej) => setTimeout(rej, (exc.rest.timeout || 5000), "TIMEOUT")),
      fetch(url, {
        method: _endpoint.method || "GET",
        headers
      })
      .then(r => r.json())
    ]);
      
    // Check for error.
    let is_error = false;
    let resp_error = exc.rest.error.key?.split('.')?.reduce((f, k) => f?.[k], r);
    if (resp_error != undefined) {
      if (exc.rest.error.is_array) {
        is_error = (resp_error.length > 0);
      } else if (exc.rest.error.value_not != undefined) {
        is_error = (resp_error != exc.rest.error.value_not);
      } else {
        is_error = (exc.rest.error.value == undefined || resp_error == exc.rest.error.value);
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

function format_timestamp (ts, at) {
  if (exc.timestamp_ISO_format || at.timestamp_ISO_format) 
    ts = new Date(ts).getTime();
  else if (exc.timestamp_in_seconds || at.timestamp_in_seconds) 
    ts = Big(ts).times(1e3).round(0, 0).toFixed() * 1;
  else if (exc.timestamp_in_micro || at.timestamp_in_micro)
    ts = Big(ts).div(1e3).round(0, 0).toFixed() * 1;
  else if (exc.timestamp_in_nano || at.timestamp_in_nano)
    ts = Big(ts).div(1e6).round(0, 0).toFixed() * 1;
  else
    ts = Big(ts).round(0, 0).toFixed() * 1;
  return ts;
}

function apply_orderbook_upd (upd, ws, just_ignore_lower_nonce_upd = (info.orderbook_snap?.is_subscribed === true)) {
  // console.log('Book upd:',upd);

  // Validate updates.
  if (upd.last_update_nonce && upd.last_update_nonce <= orderbook.last_update_nonce) {
    if (!just_ignore_lower_nonce_upd) {
      console.log('[E] apply_orderbook_upd: upd.last_update_nonce ('+upd.last_update_nonce+') <= orderbook.last_update_nonce ('+orderbook.last_update_nonce+').');
      ws.terminate();
    }
    return;
  }

  if (upd.first_update_nonce) {
    if (orderbook.received_first_update) {
      if (upd.first_update_nonce != orderbook.last_update_nonce + 1) {
        console.log('[E] apply_orderbook_upd: upd.first_update_nonce ('+upd.first_update_nonce+') <= != orderbook.last_update_nonce + 1 ('+(orderbook.last_update_nonce + 1)+').');
        ws.terminate();
        return;
      }
    } else {
      if (upd.first_update_nonce > orderbook.last_update_nonce + 1) {
        console.log('[E] apply_orderbook_upd: upd.first_update_nonce ('+upd.first_update_nonce+') > orderbook.last_update_nonce + 1 ('+(orderbook.last_update_nonce + 1)+').');
        ws.terminate();
        return;
      }
    }
  }
  
  if (delayed_orderbook === null || Math.floor(orderbook.timestamp / 1e3) != Math.floor(upd.timestamp / 1e3)) {
    let save_it = (delayed_orderbook != null);
    delayed_orderbook = {
      asks: Object.entries(orderbook.asks).sort((a, b) => Big(a[0]).cmp(b[0])).slice(0, 25),
      bids: Object.entries(orderbook.bids).sort((a, b) => Big(b[0]).cmp(a[0])).slice(0, 25),
      timestamp: orderbook.timestamp
    };
    if (save_it) orderbooks.unshift(delayed_orderbook);
  }
  
  // Apply updates.
  [ 'asks', 'bids' ].forEach(side => {
    upd[side].forEach(([ price, amount ]) => {
      if (Big(amount).eq(0)) {
        delete orderbook[side][price];
      } else {
        orderbook[side][price] = amount;
      }
    });
  });

  // Set other orderbook vars.
  orderbook.received_first_update = true;
  orderbook.timestamp = upd.timestamp;
  orderbook.last_update_nonce = upd.last_update_nonce;
}

function handle_orderbook_msg (msg, _prom, _ws, ws) {
  // console.log('Book update:',msg);

  if (msg.is_snapshot) {
    if (orderbook == null || (
      orderbook.last_update_nonce == undefined ||
      msg.last_update_nonce == undefined || 
      Big(msg.last_update_nonce).gt(orderbook.last_update_nonce)
    )) {
      // Updates 'delayed_orderbook' if it the case.
      if (orderbook != null && (
        delayed_orderbook === null || 
        Math.floor(orderbook.timestamp / 1e3) != Math.floor(msg.timestamp / 1e3)
      )) {
        let save_it = (delayed_orderbook != null);
        delayed_orderbook = {
          asks: Object.entries(orderbook.asks).sort((a, b) => Big(a[0]).cmp(b[0])).slice(0, 25),
          bids: Object.entries(orderbook.bids).sort((a, b) => Big(b[0]).cmp(a[0])).slice(0, 25),
          timestamp: orderbook.timestamp
        };
        if (save_it) orderbooks.unshift(delayed_orderbook);
      }

      orderbook = {
        asks: Object.fromEntries(msg.asks),
        bids: Object.fromEntries(msg.bids),
        timestamp: msg.timestamp,
        last_update_nonce: msg.last_update_nonce
      };

      // Apply cached orderbook updates.
      while (orderbook_upd_cache.length > 0) {
        apply_orderbook_upd(orderbook_upd_cache[0], ws, true);
        orderbook_upd_cache.shift();
      }

      if ((!info.orderbook.is_subscribed) && exc.rest.endpoints.orderbook == undefined) {
        info.orderbook.is_subscribed = true;

        // Se também já estiver incrito a 'trades' resolve a promessa.
        if (_ws.not_handle_trades === true || (info.trades?.is_subscribed && _prom)) 
          _prom.resolve();
      }
    }
  } else {
    if (orderbook == null) {
      // Just cache update.
      orderbook_upd_cache.push(msg);

    } else if (orderbook_upd_cache.length > 0) {
      // Apply all cached orderbook updates.
      while (orderbook_upd_cache.length > 0) {
        apply_orderbook_upd(orderbook_upd_cache[0], ws, true);
        orderbook_upd_cache.shift();
      }

      // Then apply update.
      apply_orderbook_upd(msg, ws);

    } else {
      // Just apply update.
      apply_orderbook_upd(msg, ws);
    }
  }
}

function handle_trades_msg (msg, _ws) {
  // console.log('Trades update:',msg);

  if (msg == null) return; // Ignore.
  const _t_upd = _ws.subcriptions.trades.update;

  if (trades == null || trades_upd_cache.length > 0) {
    // Avoid chaching trades already cached.
    if (_t_upd.id_should_be_higher === true && 
    _t_upd.trade_id_key != undefined) {
      msg = msg.filter(trade => trades_upd_cache.every(t => t.trade_id != trade.trade_id));
      if (msg.length < 1) return; // console.log('Nothig to cache here!');
    }

    trades_upd_cache = [ ...trades_upd_cache, ...msg ];
    // console.log('cached!');

  } else {
    // Avoid adding trades already added.
    if (_t_upd.id_should_be_higher === true && 
    _t_upd.trade_id_key != undefined) {
      msg = msg.filter(trade => trades.every(t => t.trade_id != trade.trade_id));
      if (msg.length < 1) return; // console.log('Nothig to add here!');
    }

    trades = [ ...trades, ...msg ];
    // console.log('added!');
  }
}

function format_orderbook_msg (msg, _ws, is_orderbook_snap = false) {
  // Essa função deve receber a mensagem de 'orderbook' e formatar para o padrão abaixo.
  // {
  //   asks: [ [ price, amount ], ... ],
  //   bids: [ [ price, amount ], ... ],
  //   timestamp: <timestamp in miliseconds>,
  //   is_snapshot: <true | false>,
  //   first_update_nonce: <upd nonce here>, *only if required.
  //   last_update_nonce: <upd nonce here>, *only if required.
  // }
  // console.log('Book msg:',msg);
  // if (is_orderbook_snap) console.log('Book snap msg:',msg);

  const _orderbook = is_orderbook_snap ? _ws.subcriptions.orderbook_snap : _ws.subcriptions.orderbook;

  // Define if this orderbook message is an updade or a snapshot.
  let is_snapshot = is_orderbook_snap;

  // 'its_first_update'
  if (info.orderbook._received_first_update !== true && 
  _orderbook.snapshot?.its_first_update === true) {
    info.orderbook._received_first_update = true;
    is_snapshot = true;
  }

  if (!is_orderbook_snap) {
    let identifier_key_value = null;
    if (_orderbook.snapshot?.identifier_key)
      identifier_key_value = _orderbook.snapshot.identifier_key?.split('.')?.reduce((f, k) => f = f?.[k], msg);
  
    if (identifier_key_value != undefined) {
      is_snapshot = (
        _orderbook.snapshot?.identifier_value == undefined || 
        identifier_key_value == _orderbook.snapshot.identifier_value
      );
    }
  }

  // Construct the formatted message.
  let updates = (msg[_orderbook.update.updates_inside] || msg);
  let asks = [];
  let bids = [];

  if (
    (is_snapshot && _orderbook.snapshot?.asks_and_bids_together) || 
    ((!is_snapshot) && _orderbook.update.asks_and_bids_together)
  ) {
    updates.forEach(x => {
      const _pl =  is_snapshot ? (_orderbook.snapshot?.pl || _orderbook.update.pl) : _orderbook.update.pl;

      let price = x[ _pl.price ];
      let amount = x[ _pl.amount ];
      let is_bids = undefined;

      if (_orderbook.update.is_bids_positive_amount) {
        is_bids = Big(x[_pl.amount]).gt(0);
        amount = Big(amount).abs().toFixed();
      } else {
        is_bids = (x[_pl.is_bids_key] == _pl.is_bids_value);
      }

      if (_pl.to_remove_key != undefined && 
      x[_pl.to_remove_key] != undefined && 
      (_pl.to_remove_value == undefined || 
      x[_pl.to_remove_key] == _pl.to_remove_value))
        amount = 0;
      
      if (is_bids)
        bids.push([ price, amount ]);
      else
        asks.push([ price, amount ]);
    });
  } else {
    asks = (updates[(is_snapshot && _orderbook.snapshot?.asks) || _orderbook.update.asks] || [])
    .map(x => [ 
      x[(is_snapshot && _orderbook.snapshot?.pl?.price) || _orderbook.update.pl.price], 
      x[(is_snapshot && _orderbook.snapshot?.pl?.amount) || _orderbook.update.pl.amount]
    ]);
    
    bids = (updates[(is_snapshot && _orderbook.snapshot?.bids) || _orderbook.update.bids] || [])
    .map(x => [ 
      x[(is_snapshot && _orderbook.snapshot?.pl?.price) || _orderbook.update.pl.price], 
      x[(is_snapshot && _orderbook.snapshot?.pl?.amount) || _orderbook.update.pl.amount] 
    ]);
  }

  let formatted = { asks, bids, is_snapshot };

  // Define the timestamp if possible.
  if (_orderbook.update.timestamp || _orderbook.snapshot?.timestamp) {
    formatted.timestamp = msg[
      (is_snapshot && _orderbook.snapshot?.timestamp) || 
      _orderbook.update.timestamp
    ];
    if (formatted.timestamp) formatted.timestamp = format_timestamp(formatted.timestamp, _orderbook.update);

  } else if (_orderbook.snapshot?.pl?.timestamp || _orderbook.update.pl?.timestamp) {
    let timestamp_asks = (updates[(is_snapshot && _orderbook.snapshot?.asks) || _orderbook.update.asks] || [])
    .map(x => x[
      (is_snapshot && _orderbook.snapshot?.pl?.timestamp) || 
      _orderbook.update.pl.timestamp
    ]);
    let max_timestamp_asks = Math.max(...timestamp_asks);

    let timestamp_bids = (updates[(is_snapshot && _orderbook.snapshot?.bids) || _orderbook.update.bids] || [])
    .map(x => x[
      (is_snapshot && _orderbook.snapshot?.pl?.timestamp) || 
      _orderbook.update.pl.timestamp
    ]);
    let max_timestamp_bids = Math.max(...timestamp_bids);

    formatted.timestamp = Math.max(max_timestamp_asks, max_timestamp_bids);
    formatted.timestamp = format_timestamp(formatted.timestamp, _orderbook.update);
  }

  // Set first and last update_nonces if required.
  if (_orderbook.update.first_upd_nonce_key)
    formatted.first_update_nonce = (msg[_orderbook.update.first_upd_nonce_key] || updates[_orderbook.update.first_upd_nonce_key]);
  else if (_orderbook.update.prev_upd_nonce_key)
    formatted.first_update_nonce = (msg[_orderbook.update.prev_upd_nonce_key] || updates[_orderbook.update.prev_upd_nonce_key]) * 1 + 1;
  
  if (_orderbook.update.last_upd_nonce_key)
    formatted.last_update_nonce = (msg[_orderbook.update.last_upd_nonce_key] || updates[_orderbook.update.last_upd_nonce_key]);

  // Retorna a mensagem formatada.
  // console.log('Formatted book msg:',formatted);
  // if (is_orderbook_snap) console.log('Formatted book snap msg:',formatted);
  return formatted;
}

function format_trades_msg (msg, _ws) {
  // Essa função deve receber a mensagem de 'trades' e formatar para o padrão abaixo.
  // (O array deve estar formatado em ordem crescente ordenado pelo 'timestamp')
  // [
  //   {
  //     timestamp: <trade time in ms>,
  //     is_buy: <true | false>,
  //     price: <trade price>,
  //     amount: <trade amount in base asset>
  //   },
  //   ...
  // ]
  // console.log('Trades msg:',msg);

  const _t_upd = _ws.subcriptions.trades.update;

  if (_t_upd.ignore_first_update === true) {
    if (info.trades.received_first_update !== true) {
      info.trades.received_first_update = true;
      return null;
    }
  }
  
  // Se recebe cada trade como um objeto unico, insere esse trade dentro de um array.
  if (_ws.subcriptions.trades.update.receive_separately_trades_as_obj) 
    msg = [ msg ];

  // Retorna trades formatados.
  return (msg?.[_ws.subcriptions.trades.update.trades_inside] || msg).map(t => {
    let timestamp = (t[_ws.subcriptions.trades.update.timestamp] || msg[_ws.subcriptions.trades.update.timestamp]);
    timestamp = format_timestamp(timestamp, _ws.subcriptions.trades.update);
    
    let obj = {
      timestamp,
      is_buy: undefined,
      price: t[_t_upd.price],
      amount: t[_t_upd.amount]
    };

    if (_t_upd.is_buy_key != undefined) {
      obj.is_buy = (t[_t_upd.is_buy_key] == _t_upd.is_buy_value);

    } else if (_t_upd.is_buy_positive_amount === true) {
      obj.is_buy = Big(obj.amount).gt(0);
      obj.amount = Big(obj.amount).abs().toFixed();

    } else {
      throw "[E] Parsing trades update: Can not determine trade side."
    }

    if (_ws.subcriptions.trades.update.trade_id_key != undefined)
      obj.trade_id = t[_ws.subcriptions.trades.update.trade_id_key];
    else
      obj.custom_id = '' + obj.timestamp + obj.is_buy + Big(obj.price).toFixed() + Big(obj.amount).toFixed();

    return obj;
  });
}

function make_subscriptions (info, ws, _ws) {
  // Envia 'to_send_before_subcriptions'.
  if (_ws.to_send_before_subcriptions != undefined) {
    for (const data of _ws.to_send_before_subcriptions)
      ws.send(data);
  }

  // Envia pedido de subscrição de trades.
  if (_ws.not_handle_trades !== true) {
    let trades_sub_req = null;
    if (_ws.subcriptions.trades?.request != undefined) {
      trades_sub_req = _ws.subcriptions.trades.request
      .replaceAll('<market>', market.ws)
      .replace('<ws_req_id>', ++ws_req_nonce);

      info.trades.req_id = _ws.subcriptions.trades.response.id_value || ws_req_nonce;
      if (isNaN(info.trades.req_id))
        info.trades.req_id = info.trades.req_id.replaceAll('<market>', market.ws);
  
      // console.log('Sending trades subscription request:\n',trades_sub_req);
      ws.send(trades_sub_req);
    }

    // Se não temos um 'trades.response', devemos asumir que 'info.trades.is_subscribed' é true apartir daqui.
    if (_ws.subcriptions.trades?.response == undefined &&
    (_ws.subcriptions.trades?.request != undefined || 
    _ws.subcriptions.trades?.is_subscribed_from_scratch)) {
      info.trades.is_subscribed = true;
      console.log('[!] Successfully subscribed to trades updates.');
      // Se também já estiver incrito a 'orderbook' resolve a promessa.
      if (_ws.not_handle_orderbook === true || (info.orderbook?.is_subscribed && _prom)) 
        _prom.resolve();
    }
  }
  
  // Envia pedido de subscriçao de orderbook.
  if (_ws.not_handle_orderbook !== true) {
    let orderbook_sub_req = null;
    if (_ws.subcriptions.orderbook?.request != undefined) {
      orderbook_sub_req = _ws.subcriptions.orderbook.request
      .replaceAll('<market>', market.ws)
      .replace('<ws_req_id>', ++ws_req_nonce);

      info.orderbook.req_id = _ws.subcriptions.orderbook.response?.id_value || ws_req_nonce;
      if (isNaN(info.orderbook.req_id))
        info.orderbook.req_id = info.orderbook.req_id.replaceAll('<market>', market.ws);
    
      // Autentica requisição de subscrição do orderbook se necessario.
      if (_ws.subcriptions.orderbook.require_auth) {
        const { signature, sign_nonce } = authenticate();
        
        orderbook_sub_req = orderbook_sub_req
        .replace('<api_key>', api.key)
        .replace('<api_pass>', api.pass)
        .replace('<sign_nonce>', sign_nonce)
        .replace('<signature>', signature);
      }
      
      // console.log('Sending orderbook subscription request:\n',orderbook_sub_req);
      ws.send(orderbook_sub_req);
    }
      
    // Se não temos um 'orderbook.response', devemos asumir que 'info.orderbook.is_upds_subscribed' é true apartir daqui.
    if (_ws.subcriptions.orderbook?.response == undefined &&
    (_ws.subcriptions.orderbook?.request != undefined ||
    _ws.subcriptions.orderbook?.is_subscribed_from_scratch)) {
      info.orderbook.is_upds_subscribed = true;
      if (exc.rest.endpoints.orderbook != undefined) {
        info.orderbook.is_subscribed = true;
        // Se também já estiver incrito a 'trades' resolve a promessa.
        if (_ws.not_handle_trades === true || (info.trades?.is_subscribed && _prom))
          _prom.resolve();
      }
      console.log('[!] Successfully subscribed to orderbook updates.');
    }

    // Envia pedido de subscriçao de orderbook snapshot.
    let orderbook_snap_sub_req = null;
    if (_ws.subcriptions.orderbook_snap?.request != undefined) {
      orderbook_snap_sub_req = _ws.subcriptions.orderbook_snap.request
      .replaceAll('<market>', market.ws)
      .replace('<ws_req_id>', ++ws_req_nonce);
  
      info.orderbook_snap.req_id = _ws.subcriptions.orderbook_snap.response.id_value || ws_req_nonce;
      
      // console.log('Sending orderbook snapshot subscription request:\n',orderbook_snap_sub_req);
      ws.send(orderbook_snap_sub_req);
    }

    // Se não temos um 'orderbook_snap.response', devemos asumir que 'info.orderbook_snap.is_subscribed' é true apartir daqui.
    if (_ws.subcriptions.orderbook_snap?.response == undefined &&
    (_ws.subcriptions.orderbook_snap?.request != undefined || 
    _ws.subcriptions.orderbook_snap?.is_subscribed_from_scratch)) {
      info.orderbook_snap.is_subscribed = true;
      console.log('[!] Successfully subscribed to orderbook snapshot updates.');
    }
  }
}

function handle_trades_sub_resp (msg, _ws, market, info, _prom) {
  info.trades.is_subscribed = true;
    
  if (_ws.subcriptions.trades?.response?.channel_id_key && 
  (_ws.subcriptions.trades.response.channel_id_val == undefined ||
  msg[_ws.subcriptions.trades.response.channel_id_key] == _ws.subcriptions.trades.response.channel_id_val.replaceAll('<market>', market.ws)))
    info.trades.channel_id = msg[_ws.subcriptions.trades.response.channel_id_key];
  else if (_ws.subcriptions.trades.update.channel_id)
    info.trades.channel_id = _ws.subcriptions.trades.update.channel_id.replaceAll('<market>', market.ws);
  else
    throw "Neither 'trades.response.channel_id_key' or 'trades.update.channel_id' are defined.";

  console.log('[!] Successfully subscribed to trades updates.');

  // Se também já estiver inscrito a 'orderbook' resolve a promessa.
  if (_ws.not_handle_orderbook === true || (info.orderbook?.is_subscribed && _prom)) 
    _prom.resolve();
}

async function connect (_ws) {
  console.log('Connecting to '+exchange+' '+market.ws+'...');

  // Reseta as variaveis.
  if (_ws.not_handle_orderbook !== true) {
    orderbook = null;
    orderbook_upd_cache = [];
  }
  if (_ws.not_handle_trades !== true) {
    trades = null;
    trades_upd_cache = [];
  }

  // Cria objeto para armazenar informações a respeito de 'orderbook' e 'trades'.
  if (_ws.not_handle_trades !== true) info.trades = {};
  if (_ws.not_handle_orderbook !== true) {
    info.orderbook = {};
    if (_ws.subcriptions.orderbook_snap) info.orderbook_snap = {};
  }

  // Se não temos um 'orderbook.response', 'info.orderbook.channel_id' deve ser definido aqui.
  if (_ws.not_handle_orderbook !== true && _ws.subcriptions.orderbook != undefined && _ws.subcriptions.orderbook.response == undefined) 
    info.orderbook.channel_id = _ws.subcriptions.orderbook.update.channel_id
      .replaceAll('<market>', market.ws);

  // Se não temos um 'trades.response', 'info.trades.channel_id' deve ser definido aqui.
  if (_ws.not_handle_trades !== true && _ws.subcriptions.trades?.response == undefined) 
    info.trades.channel_id = _ws.subcriptions.trades?.update?.channel_id
      .replaceAll('<market>', market.ws);

  // Cria uma variaveis de controle para 'ping loop'.
  let ping_loop_interval;
  let keep_alive = true;

  // Cria uma variaveis de controle para 'ws ping loop'.
  let ws_ping_loop_interval;
  let ws_keep_alive = true;

  // Cria uma promessa 'prom' e uma variavél '_prom' para futuramente resolver ou rejeitar a promessa.
  let _prom = null;
  let prom = new Promise((resolve, reject) => _prom = { resolve, reject })
  .finally(() => _prom = null); // Ao finalizar a promesa '_prom' volta ser NULL.

  // Prepare for WebSocket connection.
  if (exc.rest.endpoints.prepare_for_ws != undefined) {
    let { success, response: r } = await rest_request('prepare_for_ws');
    if (!success) {
      _prom.reject({ at: "Preparing for WebSocket connection", endpoint: 'prepare_for_ws', error: r });
      return prom;
    }

    const _r_info = exc.rest.endpoints.prepare_for_ws.response;

    const _ws_token = _r_info.ws_token_key?.split('.')?.reduce((f, k) => f?.[k], r);
    if (_ws_token != undefined) _ws.token = _ws_token;

    const _ws_url = _r_info.ws_url_key?.split('.')?.reduce((f, k) => f?.[k], r);
    if (_ws_url != undefined) _ws.url = _ws_url + "?token=<ws_token>";

    if (_ws.ping != undefined) {
      const _ws_ping_interval = _r_info.ws_ping_interval_key?.split('.')?.reduce((f, k) => f?.[k], r);
      if (_ws_ping_interval != undefined) _ws.ping.interval = _ws_ping_interval;
    }
  }

  // Cria um timeout para rejeitar a promessa caso a mesma não resolva logo.
  setTimeout(_prom.reject, (_ws.timeout || 5000), "TIMEOUT.");

  // Cria uma conexão com o websocket da exchange.
  ws = new WebSocket(
    _ws.url
    .replaceAll('<market>', market.ws)
    .replace('<ws_token>', _ws.token)
  );

  // Quando recebermos um ping, enviaremos um pong.
  ws.on('ping', ws.pong);

  // Quando recebermos um pong, manteremos a conexão aberta.
  ws.on('pong', () => keep_alive = true);

  // Quando perdemos a conexão iremos tentar nos conectar novamente.
  ws.on('close', () => {
    // Reseta as variaveis.
    if (_ws.not_handle_orderbook !== true) {
      orderbook = null;
      orderbook_upd_cache = [];
      info.orderbook = {};
      if (_ws.subcriptions.orderbook_snap) info.orderbook_snap = {};
    }
    if (_ws.not_handle_trades !== true) {
      trades = null;
      trades_upd_cache = [];
      info.trades = {};
    }

    clearInterval(ping_loop_interval);
    clearInterval(ws_ping_loop_interval);
    
    completely_sync = false;
  });

  // Quando recebermos um erro do WebSocket, iremos logar o erro e encerrar o processo.
  ws.on('error', err => {
    // Também devemos enviar um e-mail aqui.
    console.log('WebSocket error:',err);
    process.exit();
  });

  // Quando a conexão abrir devemos nos escrever as atualizações de 'orderbook' e 'trades' da exchange.
  ws.on('open', () => {
    console.log('[!] Connected.');

    // Inicia 'ping loop'.
    ping_loop_interval = setInterval(() => {
      if (!keep_alive) {
        console.log('[E] ping_loop: O servior não responseu ao nosso ping em até '+((_ws.timeout || 5000) / 1e3)+' segundos, encerrando conexão...');
        ws.terminate();
      }
      keep_alive = false;
      ws.ping();

      if (_ws.ping?.request != undefined && _ws.ping.response == undefined) // Just ping and do not wait for response.
        ws.send(_ws.ping.request);

    }, (_ws.timeout || 5000));

    // Inicia 'ws ping loop', se definido corretamente.
    if (_ws.ping?.request != undefined && _ws.ping.response != undefined) {
      ws_ping_loop_interval = setInterval(() => {
        if (!ws_keep_alive) {
          console.log('[E] ws_ping_loop: O servior não responseu ao nosso ping em até '+((_ws.ping.interval || _ws.timeout || 5000) / 1e3)+' segundos, encerrando conexão...');
          ws.terminate();
        }
        ws_keep_alive = false;
        ws.send(_ws.ping.request.replace('<ws_req_id>', ++ws_req_nonce));

      }, (_ws.ping.interval || _ws.timeout || 5000));
    }

    if (_ws.login != undefined) {
      // Sends login request.
      const { signature, sign_nonce } = authenticate();
      ws.send(
        _ws.login.request
        .replace('<api_key>', api.key)
        .replace('<api_pass>', api.pass)
        .replace('<sign_nonce>', sign_nonce)
        .replace('<signature>', signature)
      );

    } else {
      make_subscriptions(info, ws, _ws);
    }
  });

  // Finalmente, aqui processaremos os dados recebidos do servidor.
  ws.on('message', async msg => {
    // Decript message if needed
    if (_ws.gzip_encrypted) msg = await ungzip(msg);

    // Try to parse mesage as a JSON.
    try { msg = JSON.parse(msg); } catch (e) { msg = msg.toString(); }

    // console.log('WebSocket message:',msg);

    // Checks if msg is an error.
    if (msg?.[_ws.error.key] != undefined && 
    (_ws.error.value == undefined || msg[_ws.error.key] == _ws.error.value) &&
    (_ws.error.value_not == undefined || msg[_ws.error.key] != _ws.error.value_not)) {
      console.log('[E] ('+exchange+' '+market.ws+') WebSocket API Error:',msg);
      ws.terminate();
      return;
    }

    // If 'login', check if its a login response.
    if (_ws.login != undefined && 
    msg[_ws.login.response.id_key] != undefined && 
    (_ws.login.response.id_value == null || msg[_ws.login.response.id_key] == _ws.login.response.id_value)) {
      if (_ws.login.response.success_key == undefined || (
        msg[_ws.login.response.success_key] != undefined && (
          _ws.login.response.success_value == undefined || 
          msg[_ws.login.response.success_key] == _ws.login.response.success_value
        )
      )) {
        console.log('[!] Logado com sucesso.');
        make_subscriptions(info, ws, _ws);

      } else {
        console.log('[E] Falha ao fazer login:',msg);
        if (_prom) 
          _prom.reject({ endpoint: "ws-login", error: msg });
        else 
          ws.terminate();
      }

      return;
    }

    // Hanlde 'ws ping' response.
    if (_ws.ping?.response != undefined) {
      let _id_value = _ws.ping.response.id?.split('.')?.reduce((f, k) => f = f?.[k], msg);
      if (_id_value != undefined && 
      (_ws.ping.response.id_value == undefined || _id_value == _ws.ping.response.id_value)) {
        ws_keep_alive = true;
        return;
      }
    }
    
    // Handle 'trades' subscription response.
    if (_ws.not_handle_trades !== true && (!info.trades.is_subscribed) && _ws.subcriptions.trades?.request != undefined) {
      let this_is_trades_subscription_response = false;
      let id_val = _ws.subcriptions.trades.response.id?.split('.')?.reduce((f, k) => f = f?.[k], msg);

      if (_ws.subcriptions.trades.response.is_object) {
        let object_id_val = _ws.subcriptions.trades.response.object_id_key?.split('.')?.reduce((f, k) => f = f?.[k], msg);
        let id_val = _ws.subcriptions.trades.response.id?.split('.')?.reduce((f, k) => f = f?.[k], msg);

        if (object_id_val != undefined && (
        _ws.subcriptions.trades.response.object_id_value == undefined || 
        object_id_val == _ws.subcriptions.trades.response.object_id_value) &&
        id_val != undefined && id_val == info.trades.req_id)
          this_is_trades_subscription_response = true;

      } else if (_ws.subcriptions.trades.response.acum_list) {
        if (msg[_ws.subcriptions.trades.response.list_id_key] == _ws.subcriptions.trades.response.list_id_value &&
        (msg[_ws.subcriptions.trades.response.list_inside] || msg).some(
          x => x[_ws.subcriptions.trades.response.id] == _ws.subcriptions.trades.response.id_value
        ))
          this_is_trades_subscription_response = true;

      } else if (id_val != undefined && id_val == info.trades.req_id) {
        this_is_trades_subscription_response = true;
      }

      if (this_is_trades_subscription_response) 
        return handle_trades_sub_resp(msg, _ws, market, info, _prom);
    }
    
    // Handle 'orderbook' subscription response.
    if (_ws.not_handle_orderbook !== true && (!info.orderbook.is_upds_subscribed) && _ws.subcriptions.orderbook?.request != undefined) {
      let this_is_orderbook_subscription_response = false;
      let resp_id_value = _ws.subcriptions.orderbook.response.id?.split('.')?.reduce((f, k) => f = f?.[k], msg);

      if (_ws.subcriptions.orderbook.response.is_object) {
        if (msg[_ws.subcriptions.orderbook.response.object_id_key] == _ws.subcriptions.orderbook.response.object_id_value &&
        resp_id_value != undefined && (_ws.subcriptions.orderbook.response.id_value == undefined || resp_id_value == info.orderbook.req_id))
          this_is_orderbook_subscription_response = true;

      } else if (_ws.subcriptions.orderbook.response.acum_list) {
        if (msg[_ws.subcriptions.orderbook.response.list_id_key] == _ws.subcriptions.orderbook.response.list_id_value &&
        (msg[_ws.subcriptions.orderbook.response.list_inside] || msg).some(
          x => x[_ws.subcriptions.orderbook.response.id] == _ws.subcriptions.orderbook.response.id_value
        ))
          this_is_orderbook_subscription_response = true;

      } else if (resp_id_value != undefined && 
      (_ws.subcriptions.orderbook.response.id_value == undefined || 
      resp_id_value == info.orderbook.req_id)) {
        this_is_orderbook_subscription_response = true;
      }

      if (this_is_orderbook_subscription_response) {
        // Confere se resposta também inclui a incrição de 'trades'.
        if (_ws.not_handle_trades !== true && _ws.subcriptions.orderbook.response.include_trades)
          handle_trades_sub_resp(msg, _ws, market, info, _prom);

        if (_ws.subcriptions.orderbook.response.channel_id_key &&
        (_ws.subcriptions.orderbook.response.channel_id_val == undefined ||
        msg[_ws.subcriptions.orderbook.response.channel_id_key] == _ws.subcriptions.orderbook.response.channel_id_val.replaceAll('<market>', market.ws)))
          info.orderbook.channel_id = msg[_ws.subcriptions.orderbook.response.channel_id_key];
        else if (_ws.subcriptions.orderbook.update.channel_id)
          info.orderbook.channel_id = _ws.subcriptions.orderbook.update.channel_id.replaceAll('<market>', market.ws);
        else
          throw "Neither 'orderbook.response.channel_id_key' or 'orderbook.update.channel_id' are defined.";

        info.orderbook.is_upds_subscribed = true;
        console.log('[!] Successfully subscribed to orderbook updates.');
        if (exc.rest.endpoints.orderbook != undefined) {
          info.orderbook.is_subscribed = true;
          // Se também já estiver incrito a 'trades' resolve a promessa.
          if (_ws.not_handle_trades === true || (info.trades?.is_subscribed && _prom)) 
            _prom.resolve();
        }

        if (!_ws.subcriptions.orderbook.response.include_snapshot) return; // Otherwise, this message got be handled as an 'orderbook message'.
      }
    }
    
    // Handle 'orderbook_snap' subscription response.
    if (_ws.not_handle_orderbook !== true && (!info.orderbook_snap?.is_subscribed) && _ws.subcriptions.orderbook_snap?.request != undefined) {
      let this_is_orderbook_snap_subscription_response = false;
      let resp_id_value = _ws.subcriptions.orderbook_snap.response.id?.split('.')?.reduce((f, k) => f = f?.[k], msg);

      if (_ws.subcriptions.orderbook_snap.response.is_object) {
        if (msg[_ws.subcriptions.orderbook_snap.response.object_id_key] == _ws.subcriptions.orderbook_snap.response.object_id_value &&
        resp_id_value != undefined && (_ws.subcriptions.orderbook_snap.response.id_value === null || resp_id_value == info.orderbook_snap.req_id))
          this_is_orderbook_snap_subscription_response = true;

      } else if (_ws.subcriptions.orderbook_snap.response.acum_list) {
        if (msg[_ws.subcriptions.orderbook_snap.response.list_id_key] == _ws.subcriptions.orderbook_snap.response.list_id_value &&
        (msg[_ws.subcriptions.orderbook_snap.response.list_inside] || msg).some(
          x => x[_ws.subcriptions.orderbook_snap.response.id] == _ws.subcriptions.orderbook_snap.response.id_value
        ))
        this_is_orderbook_snap_subscription_response = true;
      
      } else if (resp_id_value != undefined && 
      (_ws.subcriptions.orderbook_snap.response.id_value === null || resp_id_value == info.orderbook_snap.req_id)) {
        this_is_orderbook_snap_subscription_response = true;
      }

      if (this_is_orderbook_snap_subscription_response) {
        // Confere se resposta também inclui a incrição de 'trades'.
        if (_ws.not_handle_trades !== true && _ws.subcriptions.orderbook_snap.response.include_trades)
          handle_trades_sub_resp(msg, _ws, market, info, _prom);

        if (_ws.subcriptions.orderbook_snap.response.channel_id_key &&
        (_ws.subcriptions.orderbook_snap.response.channel_id_val == undefined ||
        msg[_ws.subcriptions.orderbook_snap.response.channel_id_key] == _ws.subcriptions.orderbook_snap.response.channel_id_val.replaceAll('<market>', market.ws)))
          info.orderbook_snap.channel_id = msg[_ws.subcriptions.orderbook_snap.response.channel_id_key];
        else if (_ws.subcriptions.orderbook_snap.update.channel_id)
          info.orderbook_snap.channel_id = _ws.subcriptions.orderbook_snap.update.channel_id.replaceAll('<market>', market.ws);
        else
          throw "Neither 'orderbook_snap.response.channel_id_key' or 'orderbook_snap.update.channel_id' are defined.";

        info.orderbook_snap.is_subscribed = true;
        console.log('[!] Successfully subscribed to orderbook snapshots updates.');

        if (!_ws.subcriptions.orderbook_snap.response.include_snapshot) return; // Otherwise, this message got be handled as an 'orderbook message'.
      }
    }
    
    // Handle 'orderbook' message.
    if (_ws.not_handle_orderbook !== true && _ws.subcriptions.orderbook != undefined) {
      let _channel_id = null;
      if ((!isNaN(_ws.subcriptions.orderbook.update.channel_id_key)) && _ws.subcriptions.orderbook.update.channel_id_key != "") {
        if (Big(_ws.subcriptions.orderbook.update.channel_id_key).abs().gt(msg.length || -1))
          _channel_id = undefined
        else
          _channel_id = msg.slice(_ws.subcriptions.orderbook.update.channel_id_key)[0]
      } else {
        _channel_id = _ws.subcriptions.orderbook.update.channel_id_key?.split('.')?.reduce((f, k) => f = f?.[k], msg);
      }
      if ((info.orderbook.channel_id || _ws.subcriptions.orderbook.update.channel_id) && (
        (info.orderbook.channel_id != undefined && 
        _channel_id == info.orderbook.channel_id) || 
        (_ws.subcriptions.orderbook.update.channel_id != undefined && // In some cases the orderbook subscription response will carry the snapshot in it, and we need to be able to parse an update (send it to 'orderbook_upd_cache') before receiving the orderbook subscription response.
        _channel_id == _ws.subcriptions.orderbook.update.channel_id?.replaceAll('<market>', market.ws)) || 
        (_ws.subcriptions.orderbook?.snapshot?.channel_id != undefined &&
        _channel_id == _ws.subcriptions.orderbook.snapshot.channel_id)
      )) {
        // console.log('_channel_id:',_channel_id);
        // console.log(info.orderbook.channel_id);
        // console.log(_ws.subcriptions.orderbook.update.channel_id.replaceAll('<market>', market.ws));

        if (_ws.subcriptions.orderbook.update.data_inside?.includes(',')) {
          // Check if channel message should be ignored ('ignore_if').
          if (_ws.subcriptions.orderbook.update.ignore_if != undefined) {
            for (const [ key, value ] of _ws.subcriptions.orderbook.update.ignore_if) {
              if (msg[key] === value) return;
            }
          }

          msg
          .slice(..._ws.subcriptions.orderbook.update.data_inside.split(','))
          .forEach(x => handle_orderbook_msg(format_orderbook_msg(x, _ws), _prom, _ws, ws));
          return;
  
        } else if (_ws.subcriptions.orderbook.update.data_inside_arr && 
        _ws.subcriptions.orderbook.update.data_inside_arr_inside) {
          // Check if channel message should be ignored ('ignore_if').
          if (_ws.subcriptions.orderbook.update.ignore_if != undefined) {
            for (const [ key, value ] of _ws.subcriptions.orderbook.update.ignore_if) {
              if (msg[key] === value) return;
            }
          }

          let _base_upd = Object.keys(msg)
          .reduce((s, k) => {
            if (k != _ws.subcriptions.orderbook.update.data_inside_arr_inside)
              s[k] = msg[k];
            return s;
          }, {});
          
          msg[_ws.subcriptions.orderbook.update.data_inside_arr_inside]
          .forEach(upd => {
            handle_orderbook_msg(format_orderbook_msg({ ..._base_upd, ...upd }, _ws), _prom, _ws, ws);
          });
  
          return;
        }

        // Check if channel message should be ignored ('ignore_if').
        if (_ws.subcriptions.orderbook.update.ignore_if != undefined) {
          for (const [ key, value ] of _ws.subcriptions.orderbook.update.ignore_if) {
            if (msg[key] === value) return;
          }
        }
  
        return handle_orderbook_msg(
          format_orderbook_msg((_ws.subcriptions.orderbook.update.data_inside?.split('.')?.reduce((f, k) => f?.[k], msg) || msg), _ws),
          _prom, 
          _ws
        );
      }
    }
    
    // Handle 'orderbook_snap' message.
    if (_ws.not_handle_orderbook !== true && _ws.subcriptions.orderbook_snap != undefined) {
      let _channel_id = null;
      if (!isNaN(_ws.subcriptions.orderbook_snap.update.channel_id_key)) {
        if (Big(_ws.subcriptions.orderbook_snap.update.channel_id_key).abs().gt(msg.length || -1))
          _channel_id = undefined
        else
          _channel_id = msg.slice(_ws.subcriptions.orderbook_snap.update.channel_id_key)[0]
      } else {
        _channel_id = _ws.subcriptions.orderbook_snap.update.channel_id_key?.split('.')?.reduce((f, k) => f = f?.[k], msg);
      }
      if ((info.orderbook_snap.channel_id || _ws.subcriptions.orderbook_snap.update.channel_id) && (
        (info.orderbook_snap.channel_id != undefined &&
        _channel_id == info.orderbook_snap.channel_id) || 
        (_ws.subcriptions.orderbook_snap.update.channel_id != undefined && // In some cases the orderbook_snap subscription response will carry the snapshot in it, and we need to be able to parse an update (send it to 'orderbook_upd_cache') before receiving the orderbook subscription response.
        _channel_id == _ws.subcriptions.orderbook_snap.update.channel_id.replaceAll('<market>', market.ws))
      )) {
        if (_ws.subcriptions.orderbook_snap.update.data_inside?.includes(',')) {
          msg
          .slice(..._ws.subcriptions.orderbook_snap.update.data_inside.split(','))
          .forEach(x => handle_orderbook_msg(format_orderbook_msg(x, _ws, true), _prom, _ws));
          return;
  
        } else if (_ws.subcriptions.orderbook_snap.update.data_inside_arr && 
        _ws.subcriptions.orderbook_snap.update.data_inside_arr_inside) {
          let _base_upd = Object.keys(msg)
          .reduce((s, k) => {
            if (k != _ws.subcriptions.orderbook_snap.update.data_inside_arr_inside)
              s[k] = msg[k];
            return s;
          }, {});
          
          msg[_ws.subcriptions.orderbook_snap.update.data_inside_arr_inside]
          .forEach(upd => {
            handle_orderbook_msg(format_orderbook_msg({ ..._base_upd, ...upd }, _ws, true), _prom, _ws);
          });
  
          return;
        }
  
        return handle_orderbook_msg(
          format_orderbook_msg((_ws.subcriptions.orderbook_snap.update.data_inside?.split('.')?.reduce((f, k) => f?.[k], msg) || msg), _ws, true),
          _prom, 
          _ws
        );
      }
    }
    
    // Handle 'trades' message.
    if (_ws.not_handle_trades !== true && _ws.subcriptions.trades != undefined) {
      let _channel_id = null;
      if ((!isNaN(_ws.subcriptions.trades?.update?.channel_id_key)) && _ws.subcriptions.trades?.update?.channel_id_key != "") {
        if (Big(_ws.subcriptions.trades.update.channel_id_key).abs().gt(msg.length || -1))
          _channel_id = undefined
        else
          _channel_id = msg.slice(_ws.subcriptions.trades.update.channel_id_key)[0]
      } else {
        _channel_id = _ws.subcriptions.trades.update.channel_id_key?.split('.')?.reduce((f, k) => f = f?.[k], msg);
      }
      if (info.trades.channel_id != undefined && _channel_id == info.trades.channel_id) {
        // Check if channel message should be ignored ('ignore_if').
        if (_ws.subcriptions.trades.update.ignore_if != undefined) {
          for (const [ key, value ] of _ws.subcriptions.trades.update.ignore_if) {
            if (msg[key] === value) return;
          }
        }

        // console.log('Raw trades message:',msg);
        return handle_trades_msg(
          format_trades_msg(
            _ws.subcriptions.trades.update.data_inside != undefined ? 
              _ws.subcriptions.trades.update.data_inside.split('.').reduce((f, k) => f = f?.[k], msg) : 
                msg,
            _ws
          ),
          _ws
        );
      }
    }
    
    // Handle other updates:
    if (_ws.other_updates != undefined) {
      const updts = Object.values(_ws.other_updates);
      for (const upd of updts) {
        if (msg[upd.identifier_key] != undefined && 
        (upd.identifier_value == undefined || msg[upd.identifier_key] == upd.identifier_value)) {
          // Handle the update.

          if (upd.replace_and_respond) {
            let msg_to_respond = JSON.parse(JSON.stringify(msg));

            for (const key of (upd.to_delete_from_object || []))
              delete msg_to_respond[key];

            msg_to_respond = JSON.stringify(msg_to_respond)
            .replace(upd.to_replace, upd.replace_with);

            ws.send(msg_to_respond);
            return;
          }

          break;
        }
      }
    }
    
    // WebSocket messages to ignore.
    if (_ws.msgs_to_ignore != undefined &&
    _ws.msgs_to_ignore.some(([ key, value ]) => msg[key] && (value == undefined || msg[key] == value)))
      return;
    
    // Recebemos uma mensagem inesperada do servidor, devemos logar e finalizar o processo.
    console.log('WebSocket ('+exchange+' '+market.ws+') unexpected message:',msg);
    process.exit();
  });

  // Então retornamos a promessa criada.
  return prom;
}

async function syncronizer () {
  // Validate a exchange
  exchange = exchange.toLowerCase();
  if (!Object.keys(exchanges).includes(exchange))
    throw 'Exchange desconhecida';

  // Define o obejto 'exchange' que será usado.
  exc = exchanges[exchange];

  // Cria a função de autenticação caso necessário.
  if (exc.ws?.auth != undefined || exc.rest?.auth != undefined) {
    let _auth = (exc.ws?.auth || exc.rest?.auth);

    // Obtem chave da API apartir das variavéis de ambiente.
    api.key = process.env[exchange.toUpperCase()+'_API_KEY'];
    api.scr = process.env[exchange.toUpperCase()+'_API_SECRET'];
    api.pass = process.env[exchange.toUpperCase()+'_API_PASSPHRASE'];

    // Define a função de autenticação.
    authenticate = (path = '', body = '') => {
      let nonce = eval(_auth.nonce_to_eval); // Por enquanto única opção.

      let message = _auth.message
      .replace('<nonce>', nonce)
      .replace('<path>', path)
      .replace('<body>', body);

      // console.log('message to sign:',message);
      let signature = crypto.createHmac(
        _auth.algo, 
        _auth.secret_buffer_from != undefined ? Buffer.from(api.scr, _auth.secret_buffer_from) : api.scr
      )
      .update(message)
      .digest(_auth.digest_to);

      let to_return  = { signature, sign_nonce: nonce };

      if (_auth.encode_sign_pass) {
        let encoded_pass = crypto.createHmac(
          _auth.algo,
          _auth.secret_buffer_from != undefined ? Buffer.from(api.scr, _auth.secret_buffer_from) : api.scr
        )
        .update(api.pass)
        .digest(_auth.digest_to);

        to_return = { ...to_return, encoded_pass };
      }

      return to_return;
    };

    // Cria função que retorna os cabeçalhos HTTP de authenticação. 'get_auth_headers'
    const _auth_headers = exc.rest?.auth?.headers;
    if (_auth_headers != undefined)
      get_auth_headers = (path = '', body = '') => {
        const { signature, sign_nonce, encoded_pass } = authenticate(path, body);
        let headers = {};

        const _auth_headers = exc.rest.auth.headers;
        if (_auth_headers?.signature != undefined)
          headers[_auth_headers.signature] = signature;

        if (_auth_headers?.nonce != undefined)
          headers[_auth_headers.nonce] = exc.rest.auth.is_nonce_header_str ? ''+sign_nonce : sign_nonce;
        
        if (_auth_headers?.api_key != undefined)
          headers[_auth_headers.api_key] = api.key;
        
        if (_auth_headers?.api_pass != undefined)
          headers[_auth_headers.api_pass] = (encoded_pass || api.pass);
        
        if (_auth_headers?.extras != undefined)
          _auth_headers.extras.forEach(([k, v]) => headers[k] = v);

          return headers;
      }
  }

  // Define o mercado.
  if (exc.separator != undefined) {
    exc.rest.separator = exc.separator;
    exc.ws.separator = exc.separator;
  }
  
  if (exc.is_market_upper){
    exc.rest.is_market_upper = true;
    exc.ws.is_market_upper = true;
  }

  // console.log('base:',base);
  // console.log('quote:',quote);

  market = {
    rest: base + exc.rest.separator + quote,
    ws: base + exc.ws.separator + quote
  }

  if (exc.rest.is_market_upper)
    market.rest = market.rest.toUpperCase();
  else
    market.rest = market.rest.toLowerCase();

  if (exc.ws.is_market_upper)
    market.ws = market.ws.toUpperCase();
  else
    market.ws = market.ws.toLowerCase();

  market.ws = (exc.makert_prefix || "") + market.ws;
  market.rest = (exc.makert_prefix || "") + market.rest;

  // console.log('market:',market);

  // Obtem os pares disponíveis da exchange.
  let { success, response: r } = await rest_request('available_pairs', [ [ '<market>', market.rest ] ]);
  if (!success) {
    console.log('[E] Getting exchange markets:',r);
    throw 'Failed to get exchange markets.'
  }

  // If it returns something that is not array, tries to convert it to array.
  if (!Array.isArray(r))
    r = Object.keys(r).reduce((s, k) => [ ...s, { __key: k, ...r[k] } ] , []);

  let raw_markets = r;
  
  // Set markets by filtering raw active markets.
  markets = raw_markets
  .filter(m => 
    m?.[exc.rest.endpoints.available_pairs.response.status_key] == null || 
    m[exc.rest.endpoints.available_pairs.response.status_key] == exc.rest.endpoints.available_pairs.response.status_active
  )
  .map(m => (m?.[exc.rest.endpoints.available_pairs.response.symbol] || m));

  // console.log('markets:',markets);
  // console.log('market:',market);

  // Valida o mercado
  if (!markets.includes(market.rest))
    throw 'Mercado selecionado é inválido ou não esta ativo no momento.';

  // Tenta se conectar e se inscrever as atualizações da exchange.
  try {
    if (exc.ws2 != undefined) {
      await Promise.all([ connect(exc.ws), connect(exc.ws2) ]);
    } else {
      await connect(exc.ws);
    }
  } catch (err) {
    ws.terminate(); // Make sure websocket connection ended.
    console.log('[E] Connecting:',err);
    throw 'Connection failed.'
  }

  // Define variables to store the initial snapshot(s).
  let init_trades = null;
  let init_orderbook = null;

  // Set shorcuts for 'exc' object.
  const _t_ws = exc.ws2 != undefined && exc.ws2.subcriptions.trades ? exc.ws2 : exc.ws;
  const _ws_upd = _t_ws.subcriptions?.trades?.update;
  const _rt_rsp = exc.rest.endpoints?.trades?.response;

  // 'since' represents the start of the second that we are syncing.
  let since = Math.floor(Date.now() / 1e3);
  if (!exc.timestamp_in_seconds) since *= 1e3;

  // Tenta fazer a requisição incial de trades.
  // (prosseguir apenas quando ultimo trade do snapshot (timestamp) <= primeiro trade em 'trades_upd_cache')
  if (exc.rest.endpoints?.trades != undefined) {
    let _rt_nonce_key = _rt_rsp?.timestamp;
    let _ws_nonce_key = _ws_upd?.timestamp;
    do {
      if (init_trades != null && trades_upd_cache[0] == undefined) {
        // Do not repeat the rest request just beacause we did not receive any ws trade update, instead just wait for 1 second.
        await new Promise((res, rej) => setTimeout(res, 1e3));

      } else {
        // Make rest request to get initial trades snapshot.
        let { success, response: r } = await rest_request('trades', [
          [ '<market>', market.rest ],
          [ '<since>', since ]
        ]);
        if (!success) {
          console.log('[E] Initial trades snapshot request:',r);
          throw 'Initial trades snapshot request failed.'
        }
  
        // Do the trades pagination if possible/needed.
        const _pag = _rt_rsp?.pagination;
        if (_pag != undefined) {
          if (_pag.check_for_newer) {
            // Check for newer trades (required when using 'since' parameter and trades reponse have a limit.)
            // loop growing 'page_id' w/ the newest trade timstamp/id until the response length be lower than '_pag.max_arr_size'.
            let resp_len = r.length;
            while (resp_len >= _pag.max_arr_size) {
              if (resp_len > _pag.max_arr_size) // Just in case...
                throw "Initial trades snapshot response length > 'pagination.max_arr_size'";
  
              let newest_id = (_rt_rsp.newer_first ? r[0] : r[r.length - 1])[_pag.page_id];
  
              // If the pagination is timestamp based, decrease it by 1 for safety.
              if (_pag.page_id == _rt_rsp.timestamp) newest_id = Big(newest_id).minus(1).toFixed();
              
              let { success, response: r_pag } = await rest_request('trades', [
                [ '<market>', market.rest ],
                [ '<since>', since ],
                [ '<page_id>', newest_id ]
              ], true);
              if (!success) {
                console.log('[E] At trades pagination loop (check_for_newer):',r);
                throw "Failed to get all necessary trades.";
              }
  
              // Concatenate pagination trades.
              r = _rt_rsp.newer_first ? [ ...r_pag, ...r ] : [ ...r, ...r_pag ];
  
              resp_len = r_pag.length; // Updates 'resp_len'.
            }
          } else {
            // Make sure the oldest trade from 'init_trades' is < 'since - 1 sec'.
            // loop reducing 'page_id' w/ the oldest trade timstamp/id until the oldest trade timestamp be lower than 'older_than'. 
            const older_than = (!exc.timestamp_in_seconds) ? since - 1e3 : since - 1;
            let oldest_trade = _rt_rsp.newer_first ? r[r.length - 1] : r[0];
  
            while (oldest_trade[_rt_rsp.timestamp] >= older_than) {
              let oldest_id = oldest_trade[_pag.page_id];
  
              // If the pagination is timestamp based, increase it by 1 for safety.
              if (_pag.page_id == _rt_rsp.timestamp) oldest_id = Big(oldest_id).plus(1).toFixed();
              
              let { success, response: r_pag } = await rest_request('trades', [
                [ '<market>', market.rest ],
                [ '<since>', since ],
                [ '<page_id>', oldest_id ]
              ], true);
              if (!success) {
                console.log('[E] At trades pagination loop (check_for_newer):',r);
                throw "Failed to get all necessary trades.";
              }
  
              // Concatenate pagination trades.
              r = _rt_rsp.newer_first ? [ ...r, ...r_pag ] : [ ...r_pag, ...r ]
  
              oldest_trade = _rt_rsp.newer_first ? r[r.length - 1] : r[0]; // Updates 'oldest_trade'.
            }
          }
        }
        
        // Sort, format and remove duplicates from 'r' to 'init_trades';
        init_trades = [];
        (_rt_rsp.newer_first ? r.reverse() : r).forEach(t => {
          let timestamp = format_timestamp(t[_rt_rsp.timestamp], _rt_rsp);
  
          let obj = {
            timestamp,
            is_buy: undefined,
            price: t[_rt_rsp.price],
            amount: t[_rt_rsp.amount]
          };
  
          if (_rt_rsp.is_buy_key != undefined) {
            const is_buy_val = _rt_rsp.is_buy_key?.split('.')?.reduce((f, k) => f?.[k], t);
            obj.is_buy = (is_buy_val != undefined && (_rt_rsp.is_buy_value == undefined || is_buy_val == _rt_rsp.is_buy_key));
  
          } else if (_rt_rsp.is_buy_positive_amount === true) {
            obj.is_buy = Big(obj.amount).gt(0);
            obj.amount = Big(obj.amount).abs().toFixed();
            
          } else {
            throw "[E] Formating init_trades: Can't determine trade side."
          }
  
          if (_rt_rsp.trade_id_key != undefined)
            obj.trade_id = t[_rt_rsp.trade_id_key];
          else
            obj.custom_id = '' + obj.timestamp + obj.is_buy + Big(obj.price).toFixed() + Big(obj.amount).toFixed();
          
          const _unique_id = (obj.trade_id || obj.custom_id); // "unique"
          if (init_trades.every(it => (it.trade_id || it.custom_id) != _unique_id))
            init_trades.push(obj);
        });
      }
    } while (
      _rt_nonce_key != undefined &&
      _ws_nonce_key != undefined &&
      init_trades.length > 0 && // If no trades ocurred then it should be considered synchronized.
      (trades_upd_cache[0] == undefined ||
      Big(trades_upd_cache[0].timestamp).gt(init_trades.slice(-1)[0].timestamp))
    );

    // Remove trades em 'trades_upd_cache' já inclusos em 'init_trades'.
    trades_upd_cache = trades_upd_cache.filter(t => {
      let _key;
      if (_rt_rsp.trade_id_key != undefined) {
        _key = 'trade_id';
        if (_ws_upd.id_should_be_higher)
          return (init_trades.length == 0 || t.trade_id > init_trades[init_trades.length-1].trade_id);
      } else {
        _key = 'custom_id';
      }

      return init_trades.every(rt => rt[_key] != t[_key]);
    });
    console.log('init_trades:',init_trades);
    console.log('trades_upd_cache:',trades_upd_cache);

    // Set trades from 'init_trades' and 'trades_upd_cache'.
    trades = [ ...init_trades, ...trades_upd_cache ];

    trades_upd_cache = []; // Esvazia 'trades_upd_cache'.
    
  } else {
    trades = [];
  }

  // Tenta fazer requisição inicial do orderbook, se necessario.
  // (prosseguir apenas quando orderbook snapshot (last_update_nonce) <= primeiro update em 'orderbook_upd_cache')
  if (exc.rest.endpoints?.orderbook != undefined) {
    let _rest_update_last_nonce_key = exc.rest.endpoints.orderbook.response.last_update_nonce;
    let _ws_update_last_nonce_key = (exc.ws.subcriptions?.orderbook?.update?.last_upd_nonce_key || exc.ws2.subcriptions?.orderbook?.update?.last_upd_nonce_key);
    do {
      if (init_orderbook != null && orderbook_upd_cache[0] == undefined) {
        // Do not repeat the rest request just beacause we did not receive any ws orderbook update, instead just wait for 1 second.
        await new Promise((res, rej) => setTimeout(res, 1e3));

      } else {
        let { success, response: r } = await rest_request('orderbook', [
          [ '<market>', market.rest ]
        ]);
        if (!success) {
          console.log('[E] Initial orderbook snapshot request:',r);
          throw 'Initial orderbook snapshot request failed.'
        }
        init_orderbook = r;
      }
    } while (_rest_update_last_nonce_key != undefined &&
    _ws_update_last_nonce_key != undefined &&
    (orderbook_upd_cache[0] == undefined || 
    Big(orderbook_upd_cache[0].last_update_nonce).gt(init_orderbook[_rest_update_last_nonce_key])));
  }
  
  // If got initial orderbook, set initial orderbook.
  if (init_orderbook) {
    // Parse 'timestamp'.
    let timestamp = init_orderbook?.[exc.rest.endpoints.orderbook.response.timestamp];
    if (timestamp) timestamp = format_timestamp(timestamp, exc.rest.endpoints.orderbook.response);

    orderbook = {
      asks: Object.fromEntries(init_orderbook[exc.rest.endpoints.orderbook.response.asks]),
      bids: Object.fromEntries(init_orderbook[exc.rest.endpoints.orderbook.response.bids]),
      timestamp,
      last_update_nonce: init_orderbook?.[exc.rest.endpoints.orderbook.response.last_update_nonce]
    };
  }

  completely_sync = true;
}

// export default syncronizer;

function everySecond () {
  // Set time variables.
  const timestamp = Date.now();
  const second = Math.floor(timestamp / 1e3);
  const data_time = second - delay_time_in_seconds;

  // Call 'everySecond' again at each new second.
  setTimeout(everySecond, (second + 1) * 1e3 - timestamp);

  if (!completely_sync)
    return console.log('[E] everySecond: System is not completely synchronized so we will not post any data.');
  
  // Trades that ocurred in the last second.
  const trades_to_post = trades
  .filter(t => 
    t.timestamp > (data_time - 1) * 1e3 &&
    t.timestamp <= data_time * 1e3
  )
  .map(t => {
    delete t.trade_id;
    delete t.custom_id;

    // // Remove any key started with "_".
    // Object.keys(t).forEach(k => { if (k[0] == '_') delete t[k]; });

    return t;
  });

  // If did not received a new orderbook update do not wait until a new update comes in to update 'delayed_orderbook'.
  if (orderbook != null && orderbook.timestamp < (second - 1) * 1e3 && (delayed_orderbook == null || delayed_orderbook.timestamp != orderbook.timestamp)) {
    delayed_orderbook = {
      asks: Object.entries(orderbook.asks).sort((a, b) => Big(a[0]).cmp(b[0])).slice(0, 25),
      bids: Object.entries(orderbook.bids).sort((a, b) => Big(b[0]).cmp(a[0])).slice(0, 25),
      timestamp: orderbook.timestamp
    };
    orderbooks.unshift(delayed_orderbook);
  }

  const orderbook_to_post = orderbooks.find(ob => ob.timestamp <= data_time * 1e3) || delayed_orderbook;

  // Log everything. (Just for debug purposes...)
  if (orderbook_to_post != null) 
    console.log({
      asks: orderbook_to_post.asks.slice(0, 5),
      bids: orderbook_to_post.bids.slice(0, 5),
      book_timestamp: orderbook_to_post.timestamp,
      trades: trades_to_post,
      second: data_time,
      timestamp
    });
  // else 
  //   console.log('orderbook_to_post:',orderbook_to_post);

  // // A simpliflied version of orderbook, w/ 25 depth.
  // _orderbook = {
  //   asks: Object.entries(orderbook.asks).sort((a, b) => Big(a[0]).cmp(b[0])).slice(0, 25),
  //   bids: Object.entries(orderbook.bids).sort((a, b) => Big(b[0]).cmp(a[0])).slice(0, 25),
  //   timestamp: orderbook.timestamp
  // };

  // Remove anything older then ('delay_time_in_seconds' + 2) seconds from 'trades'.
  trades = trades.filter(t => t.timestamp > (second - (delay_time_in_seconds + 2)) * 1e3);
  
  // Remove anything older then ('delay_time_in_seconds' + 2) seconds from 'orderbooks'.
  orderbooks = orderbooks.filter(ob => ob.timestamp > (second - (delay_time_in_seconds + 2)) * 1e3);
}

// Debugging 'syncronizer'.
(async() => {
  setTimeout(everySecond, 1e3 - Date.now() % 1e3);

  // Checks if 'completely_sync' every 100ms if not call 'syncronizer()'.
  while (true) {
    if (!completely_sync) 
      await syncronizer().catch(e =>
        console.log('[E] syncronizer > Failed to synchronize:',e)
      );

    await new Promise(res => setTimeout(res, 100));
  }
})();