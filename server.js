const express = require('express');
const path = require('path');
const app = express();
const indexFile = path.join(__dirname, 'index.html');

app.get('/', (req, res) => {
  res.sendFile(indexFile);
});

app.get('/queue', (req, res) => {
  res.sendFile(indexFile);
});

app.use(express.static(path.join(__dirname), { index: false }));

const PORT = 5000;
app.listen(PORT, () => {
  console.log('MediLink running at http://localhost:' + PORT);
});
