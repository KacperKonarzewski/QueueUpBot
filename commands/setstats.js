const { PermissionsBitField, MessageFlags } = require('discord.js');
const Player = require('../models/Player');

module.exports = {
	name: 'setplayer',
	description: 'Set a player\'s points / mmr / wins / losses',
	options: [
		{
			name: 'user',
			description: 'Player to modify',
			type: 6, // USER
			required: true
		},
		{
			name: 'points',
			description: 'New points value',
			type: 4, // INTEGER
			required: false
		},
		{
			name: 'mmr',
			description: 'New hidden MMR value',
			type: 4, // INTEGER
			required: false
		},
		{
			name: 'wins',
			description: 'New match wins total',
			type: 4, // INTEGER
			required: false
		},
		{
			name: 'losses',
			description: 'New match losses total',
			type: 4, // INTEGER
			required: false
		}
	],
	async execute(interaction) {
		//--------------------------------------------
		// Permission guard: admin or specific role (same role ID as your example)
		if (
			!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) &&
			!interaction.member.roles.cache.has('1386385941278621894')
		) {
			return interaction.reply({ content: '❌ You must be an admin to use this command.', flags: MessageFlags.Ephemeral });
		}
		//--------------------------------------------

		const targetUser = interaction.options.getUser('user', true);
		const points = interaction.options.getInteger('points');
		const mmr = interaction.options.getInteger('mmr');
		const wins = interaction.options.getInteger('wins');
		const losses = interaction.options.getInteger('losses');

		// Build $set only with provided fields
		const set = {};
		if (typeof points === 'number') set.points = points;
		if (typeof mmr === 'number') set.hiddenMMR = mmr;
		if (typeof wins === 'number') set.matchWins = wins;
		if (typeof losses === 'number') set.matchLosses = losses;

		if (Object.keys(set).length === 0) {
			return interaction.reply({
				content: 'ℹ️ Nothing to update. Provide at least one of: `points`, `mmr`, `wins`, `losses`.',
				flags: MessageFlags.Ephemeral
			});
		}

		// Always refresh identity fields
		set.serverID = interaction.guild.id;
		set.discordID = targetUser.id;
		set.playerName = targetUser.tag;

		try {
			const updated = await Player.findOneAndUpdate(
                { serverID: interaction.guild.id, discordID: targetUser.id },
                { $set: set },
                { new: true, upsert: true }
            );

			const changes = [
				(typeof points === 'number') ? `points → **${updated.points}**` : null,
				(typeof mmr === 'number') ? `hiddenMMR → **${updated.hiddenMMR}**` : null,
				(typeof wins === 'number') ? `matchWins → **${updated.matchWins}**` : null,
				(typeof losses === 'number') ? `matchLosses → **${updated.matchLosses}**` : null
			].filter(Boolean).join('\n');

			await interaction.reply({
				content: `✅ Updated **${updated.playerName}** (<@${updated.discordID}>)\n${changes}`,
				flags: MessageFlags.Ephemeral
			});
		} catch (err) {
			await interaction.reply({
				content: `❌ Failed to update player: ${err?.message || 'Unknown error'}`,
				flags: MessageFlags.Ephemeral
			});
		}
		//--------------------------------------------
	}
};
