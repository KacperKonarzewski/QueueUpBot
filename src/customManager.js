const { ComponentType, MessageFlags, ChannelType  } = require('discord.js');
const Config = require('../models/Config');
const { createTextChannel, createVoiceChannel, moveUserToChannel, createCategory, moveCategoryToBottom, wait } = require('./discordUtils');
const { clearPreviousMessage, generateQueue, createButtons, createRoleButtons, sendDraftLinks } = require('./messages');
const { createDraftLinks } = require('./draftlol');
const { draftStart } = require('./draftManager');

const queue = {
    Top: [],
    Jg: [],
    Mid: [],
    Adc: [],
    Supp: []
};

const queueChannels  = {

}

const test = () => {
	queue.Top.push('user1');
	queue.Jg.push('user2');
	queue.Mid.push('user3');
	queue.Supp.push('user5');
	queue.Top.push('user6');
	queue.Jg.push('user7');
	queue.Mid.push('user8');
	queue.Supp.push('user9');
}

const reset = async (channel) => {
	queue.Top = [];
	queue.Jg = [];
	queue.Mid = [];
	queue.Adc = [];
	queue.Supp = [];
	await writeCustomQueue(channel);
}

const moveUsersToVoiceChannel = async (guild, voiceChannel, from) => {
	if (!voiceChannel) {
		return;
	}
	for (const role in queue) {
		for (const userId of queue[role]) {
			const member = guild.members.cache.get(userId);
			if (member && member.voice.channel && member.voice.channel.id === from) {
				await moveUserToChannel(member, voiceChannel);
			}
		}
	}
};

const writeCustomQueue = async (channel, client) => {

	const config = await Config.findOne({ serverID: channel.guild.id });
	clearPreviousMessage(channel, config);

	//--------------------------------------------
	test(); // For testing purposes, remove in production
    const queueMessage = await channel.send({ embeds: [generateQueue(queue, config)], components: [createButtons()] });

	await Config.findOneAndUpdate(
        { serverID: channel.guild.id },
        { lastQueueMessageID: queueMessage.id },
        { upsert: true }
    );

	//--------------------------------------------
	
    const collector = queueMessage.createMessageComponentCollector({ componentType: ComponentType.Button, time: 0 });

    collector.on('collect', async i => {
		const userId = i.user.id;

		let replied = false;

		//--------------------------------------------

		const joinQueue = async () => {
			//--------------------------------------------
			if (Object.values(queue).flat().includes(userId)) {
				await i.reply({ content: '❌ You are already in the queue!', flags: MessageFlags.Ephemeral });
				setTimeout(async () => {
					await i.deleteReply();
				}, 2000); 
				return ;
			}
			//--------------------------------------------
			const roleMsg = await i.reply({ content: 'Choose your role:', components: [createRoleButtons(queue)], flags: MessageFlags.Ephemeral });
			const filter = btn => btn.user.id === i.user.id;
			try {
				const roleInteraction = await i.channel.awaitMessageComponent({ filter, componentType: ComponentType.Button, time: 30000 });

				const role = roleInteraction.customId.replace('role_', '');
				//--------------------------------------------
				if (queue[role].length >= 2) {
					await roleInteraction.reply({ content: `❌ The ${role} role is full!`, flags: MessageFlags.Ephemeral });
					setTimeout(async () => {
						await roleInteraction.deleteReply();
					}, 2000); 
					return ;
				}
				//--------------------------------------------
				queue[role].push(userId);
				//--------------------------------------------
				await i.deleteReply();
				await roleInteraction.reply({ content: `✅ You joined as ${role}!`, flags: MessageFlags.Ephemeral });
				setTimeout(async () => {
					await roleInteraction.deleteReply();
				}, 2000);
				await queueMessage.edit({ embeds: [generateQueue(queue, config)], components: [createButtons()] });
				//--------------------------------------------
			} catch {
				await i.followUp({ content: '⏰ You did not pick a role in time.', flags: MessageFlags.Ephemeral });
				setTimeout(async () => {
					await i.deleteFollowUp();
				}, 2000); 
			}
		};
		//--------------------------------------------
		const leaveQueue = async () => {
			for (const role in queue) {
				const idx = queue[role].indexOf(userId);
				if (idx !== -1) {
					queue[role].splice(idx, 1);
					await i.reply({ content: '✅ You left the queue!', flags: MessageFlags.Ephemeral });
						setTimeout(async () => {
						await i.deleteReply();
					}, 2000);
					return false;
				}
			}
			await i.reply({ content: '❌ You are not in the queue!', flags: MessageFlags.Ephemeral });
			setTimeout(async () => {
				await i.deleteReply();
			}, 2000);
			return true;
		};
		//--------------------------------------------
		if (i.customId === 'join_queue') {
			await joinQueue();
		} 
		else if (i.customId === 'leave_queue') {
			replied = await leaveQueue();
		}
		//--------------------------------------------
		if (!replied) {
			await queueMessage.edit({ embeds: [generateQueue(queue, config)], components: [createButtons()] });
		}
		//--------------------------------------------

		const isQueueFull = Object.values(queue).every(roleArr => roleArr.length >= 2);

		//--------------------------------------------
		if (isQueueFull) {
			collector.stop('Queue is full');
		}
	});
	collector.on('end', async (collected, reason) => {
		const queueNumber = config.QueueNumber || 1;
		if (reason === 'Queue is full') {
			const mess = await channel.send({ content: 'The queue is now full! Starting the game...' });
			setTimeout(async () => {
				await mess.delete();
			}, 5000);

			//--------------------------------------------

			queueChannels['category' + queueNumber ] = await createCategory(channel.guild, `Queue #${queueNumber}`);
			await moveCategoryToBottom(queueChannels['category' + queueNumber]);

			queueChannels['text' + queueNumber] = await createTextChannel(channel.guild, queueChannels['category' + queueNumber], 'Queue #' + queueNumber),
			queueChannels['voice' + queueNumber] = await createVoiceChannel(channel.guild, queueChannels['category' + queueNumber], 'Queue VC #' + queueNumber)
			
			//--------------------------------------------

			await moveUsersToVoiceChannel(channel.guild, queueChannels['voice' + queueNumber], config.botVCchannel);

			//--------------------------------------------

			try {
				await draftStart(queue, config, queueChannels, channel.guild, queueNumber);
			}
			catch (err) {
				await queueChannels['text' + queueNumber].send({ content: err.message });
				await wait(30000);
			}
			//config.QueueNumber += 1;
			//await config.save();

		} else {
			await channel.send({ content: 'Queue collection ended.' });
		}
		await wait(30000);
		await moveUsersToVoiceChannel(channel.guild, channel.guild.channels.cache.get(config.botVCchannel), queueChannels['voice' + queueNumber].id);
		if (queueChannels['text' + queueNumber]) await queueChannels['text' + queueNumber].delete();
		if (queueChannels['voice' + queueNumber]) await queueChannels['voice' + queueNumber].delete();
		if (queueChannels['category' + queueNumber]) await queueChannels['category' + queueNumber].delete();
		reset(channel);
	});
};

module.exports = { writeCustomQueue };
