const Player = require('../models/Player');

const addPlayerIfNotExists = async (member) => {
	try {
		const existingPlayer = await Player.findOne({ discordID: member.id, serverID: member.guild.id });
		if (existingPlayer) return;

		const newPlayer = new Player({
			serverID: member.guild.id,
			playerName: member.user.username,
			discordID: member.id,
		});

		await newPlayer.save();
		console.log(`Added new player: ${member.user.username}`);
	} catch (err) {
		console.error(`Error adding player ${member.user.username}:`, err);
	}
};

module.exports = { addPlayerIfNotExists };