const { Queue, Worker, QueueEvents } = require('bullmq');
const { submitAuditToWorker } = require('../services/workerIntegration');
const logger = require('../utils/logger');
const Redis = require('ioredis');
const { query } = require('../db/postgres');
const AuditReport = require('../models/AuditReport');

// Standard Redis Connection but configured strictly for BullMQ constraints
const redisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
};

const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', redisOptions);

// 1. Create the Queue to receive jobs
const auditQueue = new Queue('complynow-audit-queue', { connection });
const auditQueueEvents = new QueueEvents('complynow-audit-queue', { connection });

// 2. Create Background Node Worker to process the jobs
const auditWorker = new Worker('complynow-audit-queue', async (job) => {
    logger.info(`Processing background Audit Job: ${job.id}`);
    
    // Write tracking state to PG
    await query(`UPDATE audits SET status = $1, updated_at = NOW() WHERE id = $2`, ['processing', job.id]);
    
    // Step 1: Update polling progress for frontend UI
    await job.updateProgress({ step: "Parsing and Scaffolding Data", percent: 15 });
    
    try {
        // Step 2: Hitting Python FastAPI Integrator
        await job.updateProgress({ step: "Calling FastAPI Worker (Orchestration)", percent: 40 });
        const workerResult = await submitAuditToWorker(job.data);
        
        // Step 3: Job finishes fetching rules
        await job.updateProgress({ step: "Bundling Results", percent: 90 });
        
        // 💾 Save raw massive JSON to MongoDB
        const reportDoc = await AuditReport.create({
          jobId: job.id,
          score: workerResult?.result?.score || 0,
          summary: workerResult?.result?.summary || {},
          issues: workerResult?.result?.issues || [],
          traffic_findings: workerResult?.result?.traffic_findings || [],
          contradictions: workerResult?.result?.contradictions || [],
          fix_simulations: workerResult?.result?.fix_simulations || [],
          requestlyMockData: workerResult?.requestlyImportPayload || null
        });

        // 💾 Update PG Metadata to Completed tracking linking to Mongo _id
        await query(`UPDATE audits SET status = $1, score = $2, mongo_report_id = $3, updated_at = NOW() WHERE id = $4`, [
            'completed', workerResult?.result?.score || 0, reportDoc._id.toString(), job.id
        ]);
        
        // The return value behaves as the final Job payload `job.returnvalue`
        return {
          message: 'Audit completed successfully',
          requestId: workerResult?.requestId,
          workerResponse: workerResult?.result,
          requestlyMockData: workerResult?.requestlyImportPayload
        };
    } catch (error) {
        logger.error(`Job ${job.id} failed during worker sync: ${error.message}`);
        await job.updateProgress({ step: "Failed", percent: 0, error: error.message });
        await query(`UPDATE audits SET status = $1, updated_at = NOW() WHERE id = $2`, ['failed', job.id]);
        throw error;
    }
}, { connection, concurrency: 5 }); // Process up to 5 audits concurrently

// 3. Optional logging events
auditWorker.on('completed', (job) => {
    logger.info(`Audit Job ${job.id} has definitively finished!`);
});
auditWorker.on('failed', (job, err) => {
    logger.error(`Audit Job ${job.id} completely failed processing: ${err.message}`);
});

module.exports = {
    auditQueue,
    auditWorker,
    auditQueueEvents
};
