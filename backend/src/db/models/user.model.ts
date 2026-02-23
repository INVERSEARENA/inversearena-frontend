import { Schema, model, type Document } from "mongoose";

export interface UserDocument extends Document {
  walletAddress: string;
  displayName?: string;
  joinedAt: Date;
  lastLoginAt: Date;
}

const UserSchema = new Schema<UserDocument>(
  {
    walletAddress: { type: String, required: true, unique: true },
    displayName: { type: String, default: undefined },
    joinedAt: { type: Date, required: true },
    lastLoginAt: { type: Date, required: true },
  },
  { timestamps: false }
);

export const UserModel = model<UserDocument>("User", UserSchema);
