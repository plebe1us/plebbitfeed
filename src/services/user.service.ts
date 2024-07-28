import { keyv } from "../config/db.js";
import { User } from "../models/user.js";

export class UserService {
    async getUser(userId: string): Promise<User | null> {
        const user = await keyv.get(userId);

        if (user) {
            return JSON.parse(user) as User;
        }

        return null;
    }
    async createUser(user: User) {
        const serielizedUser = JSON.stringify(user);
        const result = await keyv.set(user.id!, serielizedUser);
        return result;
    }
    async editUser(user: User) {
        const serielizedUser = JSON.stringify(user);
        const result = await keyv.set(user.id!, serielizedUser);
        return result;
    }
    // This maybe will never be used
    async deleteUser(userId: string) {
        const result = await keyv.delete(userId);
        return result;
    }
}
