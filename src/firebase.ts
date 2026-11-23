import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { config } from "./config.js";

if (getApps().length === 0) {
  initializeApp({
    credential: applicationDefault(),
    projectId: config.GCP_PROJECT_ID,
    storageBucket: config.STORAGE_BUCKET,
  });
}

export const db = getFirestore();
export const auth = getAuth();
export const bucket = getStorage().bucket();
