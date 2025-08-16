const mongoose = require('mongoose');

const configSchema = new mongoose.Schema({
	serverID: {
		type: String,
		required: true,
		unique: true
	},
	botChannel: String,
	botVCchannel: String,
	queueHeader: {
		type: String,
		default: 'Custom 5vs5 Queue'
	},
	lastQueueMessageID: String,
	QueueNumber: {
		type: Number,
		default: 1
	},
});

module.exports = mongoose.model('Config', configSchema);