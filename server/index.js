const app = require('./app');
const backup = require('./backup');

backup.schedule();

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Pick app running on http://localhost:${port}`));
