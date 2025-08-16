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

const test = () => {
	queue.Top.push('user1');
	queue.Jg.push('user2');
	queue.Mid.push('user3');
	queue.Adc.push('user4');
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

const moveUsersToVoiceChannel = async (guild, config, voiceChannel) => {
	if (!voiceChannel) {
		return;
	}
	for (const role in queue) {
		for (const userId of queue[role]) {
			const member = guild.members.cache.get(userId);
			if (member && member.voice.channel && member.voice.channel.id === config.botVCchannel) {
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
		if (reason === 'Queue is full') {
			const mess = await channel.send({ content: 'The queue is now full! Starting the game...' });
			setTimeout(async () => {
				await mess.delete();
			}, 5000);

			//--------------------------------------------

			const category = await createCategory(channel.guild, `Queue #${config.QueueNumber}`);
			await moveCategoryToBottom(category);
			const queueChannels  ={
				text: await createTextChannel(channel.guild, category, 'Queue #' + config.QueueNumber),
				voice: await createVoiceChannel(channel.guild, category, 'Queue VC #' + config.QueueNumber)
			}
			
			//--------------------------------------------

			await moveUsersToVoiceChannel(channel.guild, config, queueChannels.voice);

			//--------------------------------------------

			try {
				await draftStart(queue, config, queueChannels, channel.guild, client);
			}
			catch (err) {
				await queueChannels.text.send({ content: err.message });
				await wait(10000);
				await queueChannels.text.delete();
				await queueChannels.voice.delete();
				await category.delete();
				reset(channel);
				return;
			}
			//config.QueueNumber += 1;
			//await config.save();

		} else {
			await channel.send({ content: 'Queue collection ended.' });
		}
		reset(channel);
	});
};

module.exports = { writeCustomQueue };
