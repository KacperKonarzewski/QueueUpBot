const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
	serverID: {
		type: String,
		required: true,
	},
	discordID: {
		type: String,
		required: true,
	},
	playerName: {
		type: String,
		required: true
	},
	points: {
		type: Number,
		default: 500,
	},
	matchWins: {
		type: Number,
		default: 0,
	},
	matchLosses: {
		type: Number,
		default: 0,
	},
});

playerSchema.index({ serverID: 1, discordID: 1 }, { unique: true });

module.exports = mongoose.model('Player', playerSchema);
