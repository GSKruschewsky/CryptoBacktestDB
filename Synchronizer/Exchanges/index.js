import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename);

let config = {};
let cfg_files = fs
  .readdirSync(__dirname)
  .filter(file => file != path.basename(__filename) && file != "_TEMPLATE.json" && file.slice(-5) === '.json');

for (const file of cfg_files)
  config[file.slice(0, -5)] = JSON.parse(fs.readFileSync(__dirname+'/'+file));

export default config;