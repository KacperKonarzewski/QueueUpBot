const WebSocket = require('ws');

const createDraftLinks = async () => {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket('wss://draftlol.dawe.gg/', {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 OPR/120.0.0.0',
				'Origin': 'https://draftlol.dawe.gg',
				'Pragma': 'no-cache',
				'Cache-Control': 'no-cache',
				'Accept-Language': 'en-US,en;q=0.9,pl;q=0.8',
			}
		});

		ws.on('open', () => {
			const createRoomMsg = {
				type: "createroom",
				blueName: "Blue",
				redName: "Red",
				disabledTurns: [],
				disabledChamps: [],
				timePerPick: 30,
				timePerBan: 30
			};
			ws.send(JSON.stringify(createRoomMsg));
		});

		ws.on('message', (data) => {
			try {
				const msg = JSON.parse(data.toString());

				if (msg.type === 'roomcreated' && msg.roomId && msg.bluePassword && msg.redPassword) {
					const links = {
						Blue: `https://draftlol.dawe.gg/${msg.roomId}/${msg.bluePassword}`,
						Red: `https://draftlol.dawe.gg/${msg.roomId}/${msg.redPassword}`,
						Spectator: `https://draftlol.dawe.gg/${msg.roomId}`,
						Admin: `https://draftlol.dawe.gg/${msg.roomId}/${msg.adminPassword}/${msg.bluePassword}/${msg.redPassword}`
					};
					ws.close();
					resolve(links);
				}
			} catch (err) {
				reject(err);
			}
		});

		ws.on('error', (err) => {
			reject(err);
		});
	});
};

module.exports = { createDraftLinks };