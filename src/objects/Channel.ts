import { Client, Message, User } from '..';
import { Channels } from '../api/channels';
import { hasChanged } from '../util/object';

import { ulid } from 'ulid';

export default abstract class Channel {
    _data: Channels.Channel;
    client: Client;
    id: string;
    messages: Map<string, Message>;

    constructor(client: Client, data: Channels.Channel) {
        this._data = data;
        this.client = client;
        this.id = data._id;
        this.messages = new Map();

        this.patch(data);
    }

    abstract patch(data: Partial<Channels.Channel>, emitPatch?: boolean): void;
    abstract $sync(): Promise<void>;

    static async fetch(client: Client, id: string, raw?: Channels.Channel): Promise<Channel> {
        let existing;
        if (existing = client.channels.get(id)) {
            if (raw) {
                existing.patch(raw, true);
                await existing.$sync();
            }

            return existing;
        }

        let data = raw ?? (await client.Axios.get(`/channels/${id}`)).data;
        let channel: Channel;
        switch (data.channel_type) {
            case 'SavedMessages': channel = new SavedMessagesChannel(client, data); break;
            case 'DirectMessage': channel = new DirectMessageChannel(client, data); break;
            case 'Group': channel = new GroupChannel(client, data); break;
            default: throw new Error("Unknown channel type.");
        }

        await channel.$sync();
        client.channels.set(id, channel);
        client.emit('create/channel', channel);
        
        return channel;
    }

    async fetchMessage(client: Client, id: string, data?: Channels.Message): Promise<Message> {
        let existing;
        if (existing = this.messages.get(id)) {
            if (data) {
                existing.patch(data, true);
                await existing.$sync();
            }

            return existing;
        }

        let message = new Message(client, this, data ?? (await client.Axios.get(`/channels/${this.id}/messages/${id}`)).data);
        await message.$sync();
        this.messages.set(id, message);
        client.messages.set(id, message);
        client.emit('create/message', message);
        
        return message;
    }

    async sendMessage(content: string, nonce: string = ulid()) {
        let res = await this.client.Axios.post(`/channels/${this.id}/messages`, { content, nonce });
        let message = await this.fetchMessage(this.client, res.data.id, res.data);
        this.client.emit('message', message);
        return message;
    }

    async delete(preventRequest?: boolean) {
        if (!preventRequest)
            await this.client.Axios.delete(`/channels/${this.id}`);
        
        for (let id of this.messages.keys()) {
            this.client.messages.delete(id);
        }
        
        this.client.channels.delete(this.id);
        this.client.emit('delete/channel', this.id);
    }
}

export abstract class TextChannel extends Channel {
    abstract $sync(): Promise<void>;
}

export class SavedMessagesChannel extends TextChannel {
    _user: string;

    constructor(client: Client, data: Channels.Channel) {
        super(client, data);
    }

    patch(data: Channels.SavedMessagesChannel) {
        // ? info: there are no partial patches that can occur here
        this._user = data.user;
    }

    async $sync() {}
}

export class DirectMessageChannel extends TextChannel {
    recipients: Set<User>;

    _recipients: string[];

    constructor(client: Client, data: Channels.Channel) {
        super(client, data);
        this.recipients = new Set();
    }

    patch(data: Channels.DirectMessageChannel) {
        // ? info: there are no partial patches that can occur here
        this._recipients = data.recipients;
    }

    async $sync() {
        for (let recipient of this._recipients) {
            this.recipients.add(await User.fetch(this.client, recipient));
        }
    }
}

export class GroupChannel extends TextChannel {
    name: string;
    description: string;
    recipients: Set<User>;
    owner: User;
    
    _owner: string;
    _recipients: string[];

    constructor(client: Client, data: Channels.Channel) {
        super(client, data);
        this.recipients = new Set();
    }

    patch(data: Partial<Channels.GroupChannel>, emitPatch?: boolean) {
        let changedFields = hasChanged(this._data, data, !emitPatch);

        this.name = data.name ?? this.name;
        this.description = data.description ?? this.description;
        this._owner = data.owner ?? this._owner;
        this._recipients = data.recipients ?? this._recipients;
        Object.assign(this._data, data);

        if (changedFields.length > 0) {
            this.client.emit('mutation/channel', this, data);
        }
    }

    async $sync() {
        this.owner = await User.fetch(this.client, this._owner);

        for (let recipient of this._recipients) {
            this.recipients.add(await User.fetch(this.client, recipient));
        }
    }
}
