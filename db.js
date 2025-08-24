const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGO_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGO_URI is not set');
  process.exit(1);
}

mongoose.set('bufferCommands', false);

async function connectToDb() {
  const conn = await mongoose.connect(MONGODB_URI, {
  });
  await conn.connection.db.admin().command({ ping: 1 });
  console.log('✅ Mongo connected:', conn.connection.host);
  return conn;
}

module.exports = { mongoose, connectToDb };
