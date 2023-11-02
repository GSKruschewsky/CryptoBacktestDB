let express = require('express');
let router = express.Router();
let view_path = '../views';

/* GET home page. */
router.get('/', function(req, res, next) {
  res.sendFile('dashboard.html', { root: './Dashboard/views' });
});

module.exports = router;
