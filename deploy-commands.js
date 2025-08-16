const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config();

const commands = [];
const foldersPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(foldersPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
	const filePath = path.join(foldersPath, file);
	const command = require(filePath);
	commands.push({
		name: command.name,
		description: command.description,
		options: command.options || []
	});
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
	try {
		console.log(`Started refreshing ${commands.length} application (/) commands.`);

		// await rest.put(
		//     Routes.applicationCommands(process.env.CLIENT_ID),
		//     { body: commands },
		// );

		// OR: register for a single server instantly

		await rest.put(
			Routes.applicationGuildCommands(process.env.CLIENT_ID, "1405958699843063920"),
			{ body: commands },
		);

		console.log('✅ Successfully reloaded application (/) commands.');
	} catch (error) {
		console.error(error);
	}
})();
