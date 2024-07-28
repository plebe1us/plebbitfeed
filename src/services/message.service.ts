import { keyv } from "../config/db.js";

export class MessageService {
    async getMessage(id: string) {
        const message = await keyv.get(id);
        if (message) {
            return JSON.parse(message);
        }
        return null;
    }
    async createMessage(message: any) {
        const serielizedMessage = JSON.stringify(message);
        const result = await keyv.set(message.message_id, serielizedMessage);
        return result;
    }
    async createMessagePost(message: any) {
        const serielizedMessage = JSON.stringify(message);
        const result = await keyv.set(
            "post" + message.message_id,
            serielizedMessage
        );
        return result;
    }
    async editMessage(message: any) {
        const serielizedMessage = JSON.stringify(message);
        const result = await keyv.set(message.message_id, serielizedMessage);
        return result;
    }
}
