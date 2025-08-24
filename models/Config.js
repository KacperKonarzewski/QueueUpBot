const { mongoose } = require('../db');

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
	WaitForMembersTimeoutMs: {
		type: Number,
		default: 300000,
		min: 10000
	},
	CaptainsVoteTimeoutMs: {
		type: Number,
		default: 60000,
		min: 10000
	}
}, { timestamps: true });

module.exports = mongoose.models.Config || mongoose.model('Config', configSchema);
