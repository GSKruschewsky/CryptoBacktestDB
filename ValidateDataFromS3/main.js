const main = document.getElementById('content-inside');
const importer = document.getElementById('fileImport');

let data = null; 

importer.addEventListener('change', async () => {
  const [ file ] = importer.files;
  data = JSON.parse(await file.text());
  console.log('data:',data);

  const markets = [ ...new Set(Object.values(data).reduce((s, x) => [ ...s, ...Object.keys(x) ], [])) ];
  
  const mkt_selector = document.createElement("select");
  for (const market of markets) 
    mkt_selector.append(new Option(market));

  main.appendChild(mkt_selector);

  mkt_selector.addEventListener('change', showMarketData);

  showMarketData({ target: { value: 'BTC-USDT' } });
})

let main_chart = undefined;
function showMarketData ({ target: { value: selected_market } }) {
  if (!main_chart) {
    // Create a canvas to use on chart.
    const canvas = document.createElement("canvas");
    main.appendChild(canvas);

    // Define 'main_chart'.
    main_chart = new Chart(canvas, {
      type: 'line',
      data: { datasets: [] },
      options: {
        spanGaps: true,
        animation: false,
        elements: { point: { radius: 0 } },
        scales: {
          x: {
            type: 'time',
            time: { unit: 'second' }
          }
        }
      }
    });

  } else {
    // Reset chart.
    main_chart.data.datasets = [];
    main_chart.reset();
    c_idx = 0;

  }

  for (const exchange of Object.keys(data)) {
    if (!data[exchange][selected_market]) continue;

    main_chart.data.datasets = [
      ...main_chart.data.datasets,
      {
        label: exchange+' MID',
        data: data[exchange][selected_market].map(s => ({ x: s.second * 1e3, y: s.mid_price })),
        fill: false,
        borderColor: colors[c_idx],
        backgroundColor: colors[c_idx],
      },
      {
        label: exchange+' IMB',
        data: data[exchange][selected_market].map(s => ({ x: s.second * 1e3, y: s.book_imb_price })),
        fill: false,
        borderColor: colors[c_idx].slice(0, -1)+', 0.5)',
        backgroundColor: colors[c_idx].slice(0, -1)+', 0.5)',
      }
    ];

    ++c_idx;
  }

  main_chart.update();
}

let c_idx = 0;
const colors = [
  "rgb(255, 99, 132)",   // Red
  "rgb(54, 162, 235)",   // Blue
  "rgb(255, 206, 86)",   // Yellow
  "rgb(75, 192, 192)",   // Green
  "rgb(153, 102, 255)",  // Purple
  "rgb(255, 159, 64)",   // Orange
  "rgb(255, 0, 0)",      // Bright Red
  "rgb(0, 255, 0)",      // Bright Green
  "rgb(0, 0, 255)",      // Bright Blue
  "rgb(255, 255, 0)",    // Bright Yellow
  "rgb(0, 255, 255)",    // Cyan
  "rgb(255, 0, 255)",    // Magenta
  "rgb(128, 128, 128)",  // Gray
  "rgb(128, 0, 0)",      // Maroon
  "rgb(128, 128, 0)",    // Olive
  "rgb(0, 128, 0)",      // Dark Green
  "rgb(0, 0, 128)",      // Navy
  "rgb(0, 128, 128)",    // Teal
  "rgb(128, 0, 128)",    // Purple
  "rgb(192, 192, 192)"   // Silver
];
