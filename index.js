import dotenv from "dotenv";
dotenv.config();

import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import cron from "node-cron";

import { generateRandomName } from "./randomTitle.js";
import { exportStr2Txt } from "./exportStr2Txt.js";

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_ID = process.env.CATEGORY_ID;
const ADMIN_LOG_CHANNEL_ID = process.env.ADMIN_LOG_CHANNEL_ID || null;
const ARCHIVE_LIMIT = 1000;
const ROTATE_EVERY_DAYS = process.env.ROTATE_EVERY_DAYS;
const CRON_TIME = process.env.CRON_TIME;

function pickName(idx) {
    return `${generateRandomName()}-${String(idx).padStart(3, '0')}`;
}

function parseIndexFromName(name) {
    const num = name.match(/-(\d{3})$/);
    return num ? parseInt(num[1], 10) : null;

}   

function getManagedChannelsInCategory(guild) {
    const children = guild.channels.cache
        .filter((ch) => ch.parentId === CATEGORY_ID && ch.type === ChannelType.GuildText);

    const managed = [];
    let maxIndex = 0;
    let maxChannel = null;

    for (const ch of children.values()) {
        const idx = parseIndexFromName(ch.name);
        if(idx === null) continue;

        managed.push({channel: ch, index: idx});

        if(idx > maxIndex) {
            maxIndex = idx;
            maxChannel = ch;
        }
    }

    return {
        managed,
        maxIndex,
        maxChannel,
    }
}

async function logToChannel(guild, msg, isFile = false) {
    if (!ADMIN_LOG_CHANNEL_ID) return;
    const ch = guild.channels.cache.get(ADMIN_LOG_CHANNEL_ID);
    if (ch && ch.isTextBased()) {
        if(!isFile)
            await ch.send(msg);
        else 
            await ch.send({ files: [msg]});
    }
}

async function deleteChannel(guild, channel) {
    try {
        if (!channel || !channel.deletable) {
            console.warn(`삭제 불가 : ${channel?.id}`);
        }
        await channel.delete("이전 채널 삭제");
        console.log(`삭제됨: ${channel.name} ${channel.id}`);
        await logToChannel(guild, `${channel.name} 채널이 삭제되었습니다. #${channel.id}`);
    } catch(e) {
        console.error(`삭제 실패 : ${channel?.id}`);
    }
    
}

async function fetchAllMessages(channel, options = {}) {
    const limitTotal = options.limitTotal ?? Infinity;

    const all = [];

    let before = options.beforeId;

    while(true) {
        const batch = await channel.messages.fetch({
            limit: 100,
            before: before,
        });

        if(batch.size === 0) break;

        for(const msg of batch.values()) {
            all.push(msg);

            if(all.length >= limitTotal) break;
        }
        if(all.length >= limitTotal) break;

        before = batch.last().id;
    }

    all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    return all;

}

function msg2str(msg) {
    const dateStr = new Date(msg.createdTimestamp).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    return `[${dateStr}] ${msg.author.globalName} : ${msg.content}`;
}


//아카이빙
async function archiveChannel(guild, channel) { 
    if(!channel.isTextBased()) {
        return {
            channel,
            ok: false,
            error: new Error("아카이브 불가한 채널")
        }
    }

    try {
        await channel.messages.fetch({ limit: 1});
    } catch(err) {
        return {
            channel,
            ok: false,
            error: err,
        }
    }

    let allMsgs;
    try {
        allMsgs = await fetchAllMessages(channel, {limitTotal: ARCHIVE_LIMIT});
    } catch (err) {
        return {
            channel, 
            ok: false,
            error: err,
        }
    }

    const strMsg = [];
    for (const msg of allMsgs) {
        strMsg.push(msg2str(msg));
    }

    try {
        const pth = `./output/${channel.name}-${channel.id}.txt`;
        await exportStr2Txt(strMsg.join('\n'), pth);
        return {
            channel,
            ok: true,
            path: pth
        }
    }
    catch (err) {
        console.error('파일 저장 실패: ,', err);
        return err;
    }

}

async function rotate(guild) {
    const { managed, maxIndex, maxChannel } = getManagedChannelsInCategory(guild);
    
    //아카이브 및 삭제
    if (maxChannel) {
        const targets = managed.sort((a, b) => a.index - b.index);

        for (const t of targets) {
            const archiveStatus = await archiveChannel(guild, t.channel);

            if (archiveStatus.ok) {
                await logToChannel(guild, `${archiveStatus.channel.name} 채널 Archived.`);
                if(archiveStatus.path) await logToChannel(guild, archiveStatus.path, true);

                await deleteChannel(guild, t.channel);
            }
            else {
                await logToChannel(guild, `${channel.name} 채널의 아카이빙이 실패하였습니다. ${archiveStatus.error}`);
            }
        }
    }   

    //새 채널
    const newName = pickName(maxIndex + 1);
    const newChannel = await guild.channels.create({
        name: newName,
        type: ChannelType.GuildText,
        parent: CATEGORY_ID,
        reason: `Auto Create: created ${newName}`,
    })

    const deleteAt = new Date(newChannel.createdTimestamp + ROTATE_EVERY_DAYS * 86400000);

    await newChannel.send(
        `이 채널은 **${deleteAt.toLocaleString('ko-KR', {
            timeZone: 'Asia/Seoul',
        })}** 에 아카이브 후 삭제됩니다.`
    );


    await logToChannel(guild, `${newName} 채널이 만들어졌습니다. #${newChannel.id}`);

}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once("ready", async () => {
    console.log(`logged in as ${client.user.tag}`);

    const guild = await client.guilds.fetch(GUILD_ID);

    await guild.channels.fetch();

    const category = guild.channels.cache.get(CATEGORY_ID);
    if(!category || category.type !== ChannelType.GuildCategory) {
        console.error("CATEGORY_ID가 카테고리 채널이 아니거나 존재하지 않음:", CATEGORY_ID);
        process.exit(1);
    }

    //rotate(guild); //Test 용
    //const { managed, maxIndex, maxChannel } = getManagedChannelsInCategory(guild);
    
    //아무 채널도 없으면.
    if(!getManagedChannelsInCategory(guild).maxChannel) await rotate(guild); 

    cron.schedule(CRON_TIME, async () => {
        try {
            const { managed, maxChannel } = getManagedChannelsInCategory(guild);
            if(managed.length == 0) {
                await rotate(guild);
                return;
            }

            const ageMs = Date.now() - maxChannel.createdTimestamp;
            const days = ageMs / (1000 * 60 * 60 * 24);
            if(days >= ROTATE_EVERY_DAYS) {
                await rotate(guild);
            }
        } catch(e) {
            console.error("cron job failed: ", e);
            await logToChannel(guild, `채널 작업에 실패하였습니다. ${String(e).slice(0, 300)}`);
        }
    });
    
    
});

client.login(TOKEN);