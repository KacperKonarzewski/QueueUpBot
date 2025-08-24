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

//------------------------------------

const K_POINTS = 80;
const D_POINTS = 400;

const D_MMR = 400;
const PRIOR_BETA = 20;

const kHiddenFromGames = (games) => {
	const g = Math.max(0, games);
	if (g < 10) {
		const K_START = 120, K_END = 40;
		return K_START - (K_START - K_END) * (g / 10);
	}
	const K_FLOOR = 20, K_POST10 = 40, TAU = 50;
	return Math.max(K_FLOOR, K_FLOOR + (K_POST10 - K_FLOOR) * Math.exp(-(g - 10) / TAU));
};

const ROLE_ORDER = ['Top', 'Jungle', 'Mid', 'ADC', 'Support'];

const teamIds = (teams, key) => {
	return ROLE_ORDER.map(r => teams[key]?.picks?.[r]).filter(Boolean);
};

const expectedScore = (muA, muB, d) => {
	return 1 / (1 + Math.pow(10, (muB - muA) / d));
};

const smoothedWinrate = (wins, games, beta = PRIOR_BETA) => {
	return (wins + 0.5 * beta) / (games + beta);
};

const mmrMultiplier60 = (wins, games, gamma = 1.5) => {
	const w = smoothedWinrate(wins ?? 0, games ?? 0);
	const x = 2 * w - 1;
	const f = Math.sign(x) * Math.pow(Math.abs(x), gamma);
	const amp = 0.6;
	const m = 1 + amp * f;
	return Math.min(1 + amp, Math.max(1 - amp, m));
};

const bridgeFromGapSigned = (hidden, points, unit, { cap = 0.50, scale = 100 } = {}) => {
	const gap = (hidden ?? 500) - (points ?? 500);
	const t = Math.tanh(gap / scale);
	return unit >= 0 ? (1 + cap * t) : (1 - cap * t);
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

const applyMatchResult = async ({ serverID, teams, winner }) => {
	const blueIds = teamIds(teams, 'blue');
	const redIds = teamIds(teams, 'red');
	if (blueIds.length !== 5 || redIds.length !== 5) {
		throw new Error('Both teams must have 5 players before rating is applied.');
	}
	const allIds = [...new Set([...blueIds, ...redIds])];

	const docs = await Player.find({
		serverID,
		discordID: { $in: allIds }
	}).select('discordID points hiddenMMR matchWins matchLosses').lean();

	const byId = Object.fromEntries(docs.map(d => [d.discordID, d]));
	const missing = allIds.filter(id => !byId[id]);
	if (missing.length) throw new Error(`Missing Player docs for: ${missing.join(', ')}`);

	const N = 5;
	const rating = id => (byId[id]?.points ?? 500);
	const h = id => (byId[id]?.hiddenMMR ?? 500);
	const wins = id => (byId[id]?.matchWins ?? 0);
	const losses = id => (byId[id]?.matchLosses ?? 0);
	const games = id => wins(id) + losses(id);

	const muBlue_points = blueIds.reduce((a, id) => a + rating(id), 0) / N;
	const muRed_points = redIds.reduce((a, id) => a + rating(id), 0) / N;
	const Eblue_points = expectedScore(muBlue_points, muRed_points, D_POINTS);
	const Sblue = winner === 'blue' ? 1 : 0;

	const unitBlue_points = K_POINTS * (Sblue - Eblue_points);
	const unitRed_points = -unitBlue_points;

	const mBlue_points = blueIds.map(id =>
		clamp(bridgeFromGapSigned(h(id), rating(id), unitBlue_points, { cap: 0.50, scale: 100 }), 0.5, 1.5)
	);
	const mRed_points = redIds.map(id =>
		clamp(bridgeFromGapSigned(h(id), rating(id), unitRed_points, { cap: 0.50, scale: 100 }), 0.5, 1.5)
	);

	const sumMB = mBlue_points.reduce((a, b) => a + b, 0);
	const sumMR = mRed_points.reduce((a, b) => a + b, 0);

	const deltasPoints = {};
	blueIds.forEach((id, i) => {
		deltasPoints[id] = unitBlue_points * (N * mBlue_points[i] / sumMB);
	});
	redIds.forEach((id, i) => {
		deltasPoints[id] = unitRed_points * (N * mRed_points[i] / sumMR);
	});
	Object.keys(deltasPoints).forEach(id => { deltasPoints[id] = Math.round(deltasPoints[id]); });

	// -------- Hidden MMR (smooth K + non-linear ±60% personal) --------
	const muBlue_hidden = blueIds.reduce((a, id) => a + h(id), 0) / N;
	const muRed_hidden = redIds.reduce((a, id) => a + h(id), 0) / N;

	const deltasHidden = {};
	for (const id of allIds) {
		const g = games(id); // BEFORE this match
		const s = (blueIds.includes(id) ? (winner === 'blue') : (winner === 'red')) ? 1 : 0;
		const myHidden = h(id);
		const oppAvgHidden = blueIds.includes(id) ? muRed_hidden : muBlue_hidden;

		const K = kHiddenFromGames(g);
		const E = expectedScore(myHidden, oppAvgHidden, D_MMR);
		const m = mmrMultiplier60(wins(id), g); // hidden reacts to winrate
		deltasHidden[id] = Math.round(K * (s - E) * m);
	}

	const isBlueWinner = winner === 'blue';
	const bulkOps = allIds.map(id => {
		const isBlue = blueIds.includes(id);
		const won = (isBlue && isBlueWinner) || (!isBlue && !isBlueWinner);
		return {
			updateOne: {
				filter: { serverID, discordID: id },
				update: {
					$inc: {
						points: deltasPoints[id],
						hiddenMMR: deltasHidden[id],
						matchWins: won ? 1 : 0,
						matchLosses: won ? 0 : 1
					}
				},
				upsert: false
			}
		};
	});

	await Player.bulkWrite(bulkOps, { ordered: true });

	const afterPoints = Object.fromEntries(allIds.map(id => [
		id, (byId[id].points ?? 500) + deltasPoints[id]
	]));
	const afterHidden = Object.fromEntries(allIds.map(id => [
		id, (byId[id].hiddenMMR ?? 500) + deltasHidden[id]
	]));

	return {
		points: { deltas: deltasPoints, after: afterPoints },
		mmr: { deltas: deltasHidden, after: afterHidden }
	};
};

module.exports = { addPlayerIfNotExists, applyMatchResult };