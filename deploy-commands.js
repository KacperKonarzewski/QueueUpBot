const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const rest = new REST({ version: '10' }).setToken(TOKEN);

const loadCommands = () => {
	const commandsDir = path.join(__dirname, 'commands');
	const files = fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'));

	const commands = [];
	for (const file of files) {
		const cmd = require(path.join(commandsDir, file));
		commands.push({
			name: cmd.name,
			description: cmd.description,
			options: cmd.options || [],
		});
	}
	return commands;
}

const commands = loadCommands();

const deployCommandsForGuild = async (guildId) => {
	await rest.put(
		Routes.applicationGuildCommands(CLIENT_ID, guildId),
		{ body: commands }
	);
	console.log(`✅ Deployed ${commands.length} commands to guild ${guildId}`);
}

module.exports = { deployCommandsForGuild };