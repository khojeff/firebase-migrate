const admin = require('firebase-admin');

const sourceCredential = require('./source-service-account.json');
const targetCredential = require('./target-service-account.json');

// ========================================
// FIREBASE SOURCE
// ========================================
const sourceApp = admin.initializeApp(
  {
    credential: admin.credential.cert(sourceCredential),
  },
  'source'
);

// ========================================
// FIREBASE TARGET
// ========================================
const targetApp = admin.initializeApp(
  {
    credential: admin.credential.cert(targetCredential),
  },
  'target'
);

const sourceDb = sourceApp.firestore();
const targetDb = targetApp.firestore();

async function migrate(documentId) {
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;

  console.log('');
  console.log('========================================');
  console.log('FIREBASE MESSAGE MIGRATION');
  console.log('========================================');
  console.log(`Document : ${documentId}`);
  console.log('');

  try {
    // ========================================
    // GET ALL MESSAGES FROM SOURCE
    //
    // Messages/{documentId}/messages/*
    // ========================================
    const sourceMessagesRef = sourceDb
      .collection('Messages')
      .doc(documentId)
      .collection('messages');

    const snapshot = await sourceMessagesRef.get();

    if (snapshot.empty) {
      console.log('No messages found.');
      console.log('');
      console.log('========================================');
      console.log('MIGRATION STOPPED');
      console.log('========================================');
      console.log(`Document : ${documentId}`);
      console.log('Found    : 0');
      console.log('========================================');

      process.exitCode = 1;
      return;
    }

    console.log(`Found ${snapshot.size} messages.`);
    console.log('');

    // ========================================
    // PROCESS EACH MESSAGE
    // ========================================
    for (const sourceDoc of snapshot.docs) {
      processed++;

      const messageId = sourceDoc.id;

      try {
        const targetRef = targetDb
          .collection('Messages')
          .doc(documentId)
          .collection('messages')
          .doc(messageId);

        // ========================================
        // CHECK TARGET
        // ========================================
        const existingDoc = await targetRef.get();

        // ========================================
        // ALREADY EXISTS -> SKIP
        // ========================================
        if (existingDoc.exists) {
          skipped++;

          console.log(
            `[${processed}/${snapshot.size}] ${messageId} -> SKIP (already exists)`
          );

          continue;
        }

        // ========================================
        // NOT EXISTS -> MIGRATE
        // ========================================
        const data = sourceDoc.data();

        await targetRef.set(data);

        migrated++;

        console.log(
          `[${processed}/${snapshot.size}] ${messageId} -> MIGRATED`
        );

      } catch (error) {
        failed++;

        console.error(
          `[${processed}/${snapshot.size}] ${messageId} -> FAILED`
        );

        console.error(`Error: ${error.message}`);
      }
    }

    // ========================================
    // SUMMARY
    // ========================================
    console.log('');
    console.log('========================================');
    console.log('MIGRATION FINISHED');
    console.log('========================================');
    console.log(`Document : ${documentId}`);
    console.log('');
    console.log(`Found    : ${snapshot.size}`);
    console.log(`Migrated : ${migrated}`);
    console.log(`Skipped  : ${skipped}`);
    console.log(`Failed   : ${failed}`);
    console.log('========================================');

    if (failed > 0) {
      process.exitCode = 1;
    }

  } catch (error) {
    console.error('');
    console.error('========================================');
    console.error('MIGRATION FAILED');
    console.error('========================================');
    console.error(`Document : ${documentId}`);
    console.error(`Error    : ${error.message}`);
    console.error('========================================');

    process.exitCode = 1;
  }
}

// ========================================
// GET DOCUMENT ID FROM COMMAND LINE
// ========================================

const documentId = process.argv[2];

if (!documentId) {
  console.error('');
  console.error('Document ID is required.');
  console.error('');
  console.error('Usage:');
  console.error('node migrate.js <DOCUMENT_ID>');
  console.error('');

  process.exit(1);
}

migrate(documentId);