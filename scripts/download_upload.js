const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

// API endpoints
const MP3_API = "https://backendmix.vercel.app/mp3";
const CHANNEL_API = "https://backendmix-emergeny.vercel.app/list";

// Configuration
const TEMP_DOWNLOAD_DIR = path.join(__dirname, "..", "temp_downloads");
const DOWNLOADS_JSON = path.join(__dirname, "..", "downloads.json");
const MAX_RETRIES = 5;
const CHANNEL_ID = "UCcKMjICfQPjiVMpqS-yF7hA"; // Hardcoded Channel ID

// Internet Archive configuration
const IA_IDENTIFIER = "akkidark";
const IA_ACCESS_KEY = "cCYXD3V4ke4YkXLI";
const IA_SECRET_KEY = "qZHSAtgw5TJXkpZa";
const IA_BASE_URL = `https://archive.org/serve/${IA_IDENTIFIER}/`;

// Ensure the download directory exists
fs.ensureDirSync(TEMP_DOWNLOAD_DIR);

// Load existing downloads data
let downloadsData = {};
if (fs.existsSync(DOWNLOADS_JSON)) {
    try {
        downloadsData = JSON.parse(fs.readFileSync(DOWNLOADS_JSON, "utf-8"));
        console.log(`📋 Loaded ${Object.keys(downloadsData).length} existing downloads from JSON`);
    } catch (err) {
        console.error("❌ Failed to load downloads.json, resetting file.");
        downloadsData = {};
    }
}

/**
 * Upload multiple files to Internet Archive
 * @param {Array} filesToUpload Array of {filePath, videoId, title} objects
 * @returns {Array} Results with success/failure for each file
 */
async function batchUploadToInternetArchive(filesToUpload) {
    console.log(`📤 Batch uploading ${filesToUpload.length} files to Internet Archive...`);
    
    // Create Python script for batch upload
    const pythonScript = `
import os
import sys
import json
import internetarchive

# Load batch data
batch_data = json.loads(sys.argv[1])

# Internet Archive credentials
access_key = "${IA_ACCESS_KEY}"
secret_key = "${IA_SECRET_KEY}"
identifier = "${IA_IDENTIFIER}"

# Process each file
results = []

for item in batch_data:
    filepath = item["filePath"]
    video_id = item["videoId"]
    title = item["title"]
    filename = os.path.basename(filepath)
    
    print(f"Uploading {filename}...")
    
    try:
        response = internetarchive.upload(
            identifier=identifier,
            files=[filepath],
            metadata={
                "title": title,
                "mediatype": "audio",
                "collection": "opensource_audio",
                "creator": "YouTube Clone - ShradhaKD",
                "youtube_id": video_id
            },
            config={
                "s3": {
                    "access": access_key,
                    "secret": secret_key
                }
            },
            verbose=True
        )
        
        success = True
        for r in response:
            if r.status_code != 200:
                print(f"❌ Upload failed for {filename} with status {r.status_code}: {r.text}")
                success = False
            else:
                print(f"✅ Successfully uploaded {filename}")
        
        results.append({
            "videoId": video_id,
            "success": success
        })
    except Exception as e:
        print(f"❌ Exception uploading {filename}: {str(e)}")
        results.append({
            "videoId": video_id,
            "success": False
        })

# Output results as JSON
print(json.dumps(results))
`;

    try {
        const scriptPath = path.join(TEMP_DOWNLOAD_DIR, "batch_upload_script.py");
        fs.writeFileSync(scriptPath, pythonScript);
        
        // Create JSON string of files to upload
        const batchDataJson = JSON.stringify(filesToUpload);
        
        // Run Python upload script with batch data
        const result = spawnSync("python", [scriptPath, batchDataJson], {
            encoding: "utf-8",
            stdio: "pipe",
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large output
        });
        
        if (result.status !== 0) {
            console.error(`❌ Batch upload script failed: ${result.stderr}`);
            return filesToUpload.map(item => ({ videoId: item.videoId, success: false }));
        }
        
        // Try to parse results from the script output
        try {
            // Find and extract the JSON part from the output
            const outputLines = result.stdout.split('\n');
            const jsonLine = outputLines.filter(line => line.trim().startsWith('[')).pop();
            
            if (jsonLine) {
                return JSON.parse(jsonLine);
            } else {
                console.error("❌ Could not find JSON results in script output");
                return filesToUpload.map(item => ({ videoId: item.videoId, success: false }));
            }
        } catch (parseErr) {
            console.error(`❌ Failed to parse upload results: ${parseErr.message}`);
            console.log("Script output:", result.stdout);
            return filesToUpload.map(item => ({ videoId: item.videoId, success: false }));
        }
    } catch (err) {
        console.error(`❌ Error in batch upload: ${err.message}`);
        return filesToUpload.map(item => ({ videoId: item.videoId, success: false }));
    }
}

/**
 * Commit changes to the downloads.json file
 */
function commitChangesToJson() {
    try {
        execSync("git config --global user.name 'github-actions'");
        execSync("git config --global user.email 'github-actions@github.com'");
        execSync(`git add "${DOWNLOADS_JSON}"`);
        execSync(`git commit -m "Update downloads.json with newly processed videos"`);
        execSync("git push");
        console.log(`📤 Committed and pushed updates to downloads.json`);
    } catch (err) {
        console.error("❌ Error committing file:", err.message);
    }
}

/**
 * Main function to download videos and upload to Internet Archive
 */
(async () => {
    try {
        console.log(`🔍 Fetching videos for channel ID: ${CHANNEL_ID}...`);
        const response = await axios.get(`${CHANNEL_API}/${CHANNEL_ID}`);

        if (!response.data || !response.data.videos || response.data.videos.length === 0) {
            console.error("❌ No videos found for this channel.");
            process.exit(1);
        }

        const videoIds = response.data.videos;
        console.log(`📹 Found ${videoIds.length} videos, checking which ones need processing...`);

        let processedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;
        
        // Track downloaded files for batch upload
        const downloadedFiles = [];
        const failedIds = [];

        // PHASE 1: DOWNLOAD ALL FILES
        console.log(`\n📥 PHASE 1: DOWNLOADING ALL FILES`);
        
        for (const videoId of videoIds) {
            const filename = `${videoId}.webm`;
            const filePath = path.join(TEMP_DOWNLOAD_DIR, filename);

            // Skip if already in our records
            if (downloadsData[videoId] && downloadsData[videoId].filePath) {
                console.log(`⏭️ Skipping ${videoId}, already processed`);
                skippedCount++;
                continue;
            }

            console.log(`🎵 Downloading video ${videoId}...`);

            let downloadSuccess = false;
            let videoTitle = `Video ${videoId}`;
            
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    console.log(`🔄 Download attempt ${attempt}/${MAX_RETRIES}...`);

                    // Get the download URL and filename from the MP3 API
                    const downloadResponse = await axios.get(`${MP3_API}/${videoId}`);
                    const { url, filename: titleFromApi } = downloadResponse.data;

                    if (!url) {
                        throw new Error("No download URL returned from API");
                    }

                    // Clean up filename to use as title (remove .mp3 extension if present)
                    videoTitle = titleFromApi 
                        ? titleFromApi.replace(/\.mp3$/, '').trim() 
                        : `Video ${videoId}`;

                    // Download the audio file
                    const writer = fs.createWriteStream(filePath);
                    const audioResponse = await axios({
                        url,
                        method: "GET",
                        responseType: "stream",
                        timeout: 60000
                    });

                    audioResponse.data.pipe(writer);

                    await new Promise((resolve, reject) => {
                        writer.on("finish", resolve);
                        writer.on("error", reject);
                    });

                    // Get file size
                    const fileSize = fs.statSync(filePath).size;

                    if (fileSize === 0) {
                        throw new Error("Downloaded file size is 0 bytes");
                    }

                    console.log(`✅ Downloaded ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
                    console.log(`📝 Title: ${videoTitle}`);

                    downloadedFiles.push({
                        filePath: filePath,
                        videoId: videoId,
                        title: videoTitle,
                        size: fileSize
                    });
                    
                    downloadSuccess = true;
                    break;
                } catch (err) {
                    console.error(`⚠️ Error downloading ${videoId}: ${err.message}`);
                    
                    // Clean up partial download if it exists
                    if (fs.existsSync(filePath)) {
                        try {
                            fs.unlinkSync(filePath);
                            console.log(`🗑️ Removed failed download: ${filePath}`);
                        } catch (cleanupErr) {
                            console.error(`⚠️ Failed to clean up file: ${cleanupErr.message}`);
                        }
                    }
                    
                    if (attempt === MAX_RETRIES) {
                        console.error(`❌ Failed to download ${videoId} after ${MAX_RETRIES} attempts, skipping.`);
                        failedIds.push(videoId);
                        errorCount++;
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

            if (!downloadSuccess) {
                console.error(`🚨 Failed to download: ${videoId}`);
            }
        }

        // PHASE 2: BATCH UPLOAD ALL DOWNLOADED FILES
        console.log(`\n📤 PHASE 2: BATCH UPLOADING ${downloadedFiles.length} FILES`);
        
        if (downloadedFiles.length > 0) {
            // Batch upload all files
            const uploadResults = await batchUploadToInternetArchive(downloadedFiles);
            
            // Process results and update downloads.json
            for (const result of uploadResults) {
                const { videoId, success } = result;
                const fileInfo = downloadedFiles.find(file => file.videoId === videoId);
                
                if (success && fileInfo) {
                    const filename = path.basename(fileInfo.filePath);
                    const iaFilePath = `${IA_BASE_URL}${filename}`;
                    
                    // Update downloads.json
                    downloadsData[videoId] = {
                        title: fileInfo.title,
                        id: videoId,
                        filePath: iaFilePath,
                        size: fileInfo.size,
                        uploadDate: new Date().toISOString()
                    };
                    
                    processedCount++;
                    console.log(`✅ Successfully processed ${videoId}`);
                } else {
                    errorCount++;
                    console.error(`❌ Failed to upload ${videoId}`);
                }
            }
            
            // Save updated downloads JSON
            fs.writeFileSync(DOWNLOADS_JSON, JSON.stringify(downloadsData, null, 2));
            console.log(`📝 Updated downloads.json with ${processedCount} new entries`);
            
            // Commit changes
            if (processedCount > 0) {
                commitChangesToJson();
            }
        } else {
            console.log(`⏭️ No new files to upload`);
        }

        // PHASE 3: CLEANUP
        console.log(`\n🧹 PHASE 3: CLEANING UP DOWNLOADED FILES`);
        
        // Clean up downloaded files
        for (const fileInfo of downloadedFiles) {
            try {
                if (fs.existsSync(fileInfo.filePath)) {
                    fs.unlinkSync(fileInfo.filePath);
                    console.log(`🗑️ Removed ${path.basename(fileInfo.filePath)}`);
                }
            } catch (err) {
                console.error(`⚠️ Error deleting ${fileInfo.filePath}: ${err.message}`);
            }
        }

        console.log(`\n📊 Summary:`);
        console.log(`✅ Successfully processed: ${processedCount} videos`);
        console.log(`⏭️ Skipped (already processed): ${skippedCount} videos`);
        console.log(`❌ Failed: ${errorCount} videos`);
        console.log(`🌐 Internet Archive collection: https://archive.org/details/${IA_IDENTIFIER}`);

    } catch (error) {
        console.error("❌ Error:", error.message);
        process.exit(1);
    } finally {
        // Double-check and clean up any remaining files in temp directory
        try {
            const tempFiles = fs.readdirSync(TEMP_DOWNLOAD_DIR)
                .filter(file => file.endsWith('.webm'));
            
            if (tempFiles.length > 0) {
                console.log(`🧹 Cleaning up ${tempFiles.length} remaining temporary files...`);
                tempFiles.forEach(file => {
                    const filePath = path.join(TEMP_DOWNLOAD_DIR, file);
                    fs.unlinkSync(filePath);
                });
            }
        } catch (err) {
            console.error(`⚠️ Error during final cleanup: ${err.message}`);
        }
    }
})();
