[1mdiff --git a/db.js b/db.js[m
[1mindex 4be81ff..1c330ee 100644[m
[1m--- a/db.js[m
[1m+++ b/db.js[m
[36m@@ -96,17 +96,17 @@[m [mfunction initializeFirebase() {[m
   }[m
 [m
   try {[m
[31m-    if (!admin.apps || admin.apps.length === 0) {[m
[32m+[m[32m    if (admin.getApps().length === 0) {[m
       admin.initializeApp({[m
         credential: admin.cert(serviceAccount)[m
       });[m
     }[m
   } catch (error) {[m
[31m-    console.warn('Firebase credentials are invalid or incomplete. Falling back to local development mode.');[m
[32m+[m[32m    console.error('Firebase initialization failed:', error.code || error.message);[m
     return false;[m
   }[m
 [m
[31m-  firestoreDb = getFirestore();[m
[32m+[m[32m  firestoreDb = getFirestore(admin.getApp());[m
   return true;[m
 }[m
 [m
[1mdiff --git a/server.js b/server.js[m
[1mindex 94d9ca5..a16425f 100644[m
[1m--- a/server.js[m
[1m+++ b/server.js[m
[36m@@ -3,6 +3,7 @@[m [mconst fs = require('fs');[m
 const path = require('path');[m
 const { randomUUID } = require('crypto');[m
 const admin = require('firebase-admin');[m
[32m+[m[32mconst { getAuth } = require('firebase-admin/auth');[m
 const database = require('./db');[m
 const { createAuthentication, requireAdmin } = require('./auth');[m
 [m
[36m@@ -54,12 +55,12 @@[m [mfunction createApp(options = {}) {[m
     appId: process.env.FIREBASE_WEB_APP_ID[m
   }));[m
   const verifyIdToken = options.verifyIdToken || ((token) => {[m
[31m-    if (!admin.apps || admin.apps.length === 0) {[m
[32m+[m[32m    if (admin.getApps().length === 0) {[m
       const error = new Error('Firebase Authentication is not initialized.');[m
       error.code = 'AUTH_UNAVAILABLE';[m
       throw error;[m
     }[m
[31m-    return admin.auth().verifyIdToken(token);[m
[32m+[m[32m    return getAuth(admin.getApp()).verifyIdToken(token);[m
   });[m
   const authentication = createAuthentication(verifyIdToken);[m
   const app = express();[m
