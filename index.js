const Telegraf = require('telegraf')
const telegrafStart = require('telegraf-start-parts')
const debug = require('debug')
const stringify = require('json-stringify-safe')
const { Resources, Translation } = require('nodejs-i18n')

const config = require('./config')
const database = require('./database')

const items = {
	...require('./items/null'), //0
	...require('./items/city'),
	...require('./items/bank') //5
}

const bot = new Telegraf(process.env.telegram_token, {
	username: 'DefendTheCastleBot'
})
const dlogBot = debug("bot")
const dlogPlugins = debug("bot:plugins")
const dlogReply = debug("bot:reply")
const dlogInline = debug("bot:inline")
const dlogCallback = debug("bot:callback")
const dlogError = debug("bot:error")

dlogBot("Start bot")
let startLog = `
#Start
<b>BOT START</b>
<b>Username:</b> @DefendTheCastleBot
`
bot.telegram.sendMessage(process.env.log_chat,
	startLog, {
		parse_mode: 'HTML'
	}
)

const processError = (error, ctx, plugin) => {
	var fulllog = []
	var logId = `${+ new Date()}_`
	if (ctx && ctx.update && ctx.update.update_id) {
		logId += `${ctx.update.update_id}`
	} else {
		logId += 'NoUpdate'
	}

	var errorMsg = 'ERROR'
	if (ctx && ctx._) {
		errorMsg = ctx._('ERROR')
	}
	errorMsg += ` \`ID:${logId}\``

	if (ctx && ctx.updateType) {
		if (ctx.updateType == 'message') {
			ctx.replyWithMarkdown(errorMsg)
		} else if (ctx.updateType == 'callback_query' || ctx.updateType == 'edited_message') {
			ctx.editMessageText(errorMsg, {
				parse_mode: 'Markdown'
			})
		} else if (ctx.updateType == '') {
			ctx.answerCbQuery(
				errorMsg.replace(/\*/g, '').replace(/`/g, ''),
				true
			)
		}
	}

	if (error) {
		fulllog.push({
			type: 'error',
			data: error
		})
		dlogError(`Oooops ${error}`)
	}
	if (ctx) {
		fulllog.push({
			type: 'ctx',
			data: ctx
		})
	}
	if (plugin) {
		fulllog.push({
			type: 'plugin',
			data: plugin
		})
	}

	var clearUser = (user) => JSON.stringify(user).replace(/[{"}]/g, '').replace(/,/g, '\n').replace(/:/g, ': ')

	var text = `#Error ID:${logId}`
	if (plugin && plugin.id) {
		text += `\nPlugin ~> ${plugin.id}`
	}
	if (error) {
		text += `\nERROR ~>\n${error.toString()}\n`
	}
	if (ctx && ctx.from) {
		text += `\nFROM ~>\n${clearUser(ctx.from)}\n`
	}
	if (ctx && ctx.chat) {
		text += `\nCHAT ~>\n${clearUser(ctx.chat)}`
	}

	bot.telegram.sendMessage(process.env.log_chat, text.substring(0, 4000))

	var jsonData = stringify(fulllog)
	var remove = (name) => {
		jsonData = jsonData.replace(new RegExp(name, 'gi'), 'OPS_SECRET')
	}

	[
		process.env.telegram_token
		//add more...
	].forEach(name => remove(name))

	return bot.telegram.sendDocument(
		process.env.log_chat,
		{
			filename: `${logId}.log.JSON`,
			source: Buffer.from(jsonData, 'utf8')
		}
	)
}

var inline = []
var callback = []
var reply = []

bot.use((ctx, next) => telegrafStart(ctx, next))

/*
const r = new Resources({
	lang: config.defaultLang
})
config.locales.forEach((id) => {
	r.load(id, `locales/${id}.po`)
})
*/
bot.use((ctx, next) => {
	//var langCode = 'en' //checkLanguage(ctx)
	//var i18n = new Translation(langCode)
	ctx._ = (t) => t //i18n._.bind(i18n)
	//ctx.langCode = langCode
	return next(ctx)
})

bot.context.database = database
bot.context.castles = config.castles
bot.context.items = items
bot.context.userInfo = async (ctx, onlyUser) => {
	if (typeof ctx != 'object') {
		ctx = {
			from: ctx //ctx == id
		}
	}
	let db = await database.getUser(ctx.from.id)
	if (!db) {
		if (typeof ctx == 'object' && onlyUser) {
			await ctx.replyWithMarkdown('*What\'s the name of your town?*', {
				reply_markup: {
					force_reply: true
				}
			})
		}
		return false
	}
	var data = {
		maxLevel: config.maxLevel,
		maxTroops: 5,
		plusAtack: 0,
		plusShield: 0,
		plusLife: 0,
		plusXp: 0,
		plusMoney: 0,
		moneyPerHour: 0,
		...db,
		...config.class[db.type],
		castle: config.castles[db.city[12]] || '🏰'
	}
	data.inventory = data.inventory.reduce((total, id) => {
		if (id != 0) {
			total.push(id)
		}
		return total
	}, [0])
	data.allItems = data.city.reduce((total, id, index) => {
		if (id != 12) {
			total.push({
				...items[id],
				city: true
			})
		}
		return total
	}, data.inventory.map((id) => {
		return {
			...items[id],
			inventory: true
		}
	}))
	for (var item of data.allItems) {
		if (item.doDb) {
			data = item.doDb(data)
		}
		if (data.run && item.doTime) {
			data = item.doTime(data)
		}
	}
	data.money = Math.round(data.money)
	if (data.run) {
		//TODO Update db
	}
	return data
}

config.plugins.forEach(p => {
	var _ = require(`./plugins/${p}`)
	dlogBot(`Install plugin: ${_.id}`)

	if (_.install) {
		try {
			_.install()
		} catch (e) {
			processError(e, false, _)
		}
	}

	if (_.plugin) {
		bot.hears(_.regex, async (ctx) => {
			dlogPlugins(`Runnig cmd plugin: ${_.id}`)
			try {
				ctx.db = await ctx.userInfo(ctx, _.onlyUser)
				if (!ctx.db && _.onlyUser) return false
				await _.plugin(ctx)
			} catch (e) {
				processError(e, ctx, _)
			}
		})
	}

	if (_.inline) {
		inline.push(_)
	}

	if (_.callback) {
		callback.push(_)
	}

	if (_.reply) {
		reply.push(_)
	}
})

bot.on('message', async (ctx) => {
	var msg = ctx.message
	if (msg.reply_to_message && msg.reply_to_message.text && msg.text) {
		for (var _ of reply) {
			dlogReply(`Runnig Reply plugin: ${_.id}`)
			ctx.match = [
				msg.reply_to_message.text,
				msg.text
			]
			try {
				ctx.db = await ctx.userInfo(ctx)
				//if (!ctx.db) return false
				await _.reply(ctx)
			} catch (e) {
				processError(e, ctx, _)
			}
		}
	}
})

bot.on('callback_query', async (ctx) => {
	if (ctx.update && ctx.update.callback_query && ctx.update.callback_query.data) {
		var data = ctx.update.callback_query.data
		for (var _ of callback) {
			if (data.startsWith(_.id)) {
				ctx.match = [].concat(data, data.split(':'))
				dlogCallback(`Runnig callback plugin: ${_.id}`)
				try {
					ctx.db = await ctx.userInfo(ctx)
					//if (!ctx.db) return false
					await _.callback(ctx)
				} catch (e) {
					processError(e, ctx, _)
				}
			}
		}
	}
})

bot.catch((err) => {
	try {
		processError(err, false, false)
	} catch (e) {
		dlogError(`Oooops ${err}`)
		dlogError(`OH!!! ${e}`)
	}
})

bot.startPolling()