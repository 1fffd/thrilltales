const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const MP3_API = "https://backendmix.vercel.app/mp3";
const CHANNEL_API = "https://backendmix-emergeny.vercel.app/list";
const DOWNLOAD_DIR = path.join(__dirname, "..", "tt");
const DOWNLOADS_JSON = path.join(__dirname, "..", "downloads.json");
const MAX_RETRIES = 3;
const CHANNEL_ID = "UCcKMjICfQPjiVMpqS-yF7hA"; // 🔥 Hardcoded Channel ID
const FILE_BASE_URL = "https://thrilltales.netlify.app/tt/";

// Ensure the download directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Load existing downloads data and update old file paths
let downloadsData = {};
if (fs.existsSync(DOWNLOADS_JSON)) {
    try {
        downloadsData = JSON.parse(fs.readFileSync(DOWNLOADS_JSON, "utf-8"));
        for (const videoId in downloadsData) {
            if (!downloadsData[videoId].filePath.startsWith(FILE_BASE_URL)) {
                downloadsData[videoId].filePath = `${FILE_BASE_URL}${videoId}.webm`;
            }
        }
        fs.writeFileSync(DOWNLOADS_JSON, JSON.stringify(downloadsData, null, 2));
    } catch (err) {
        console.error("❌ Failed to load downloads.json, resetting file.");
        downloadsData = {};
    }
}

(async () => {
    try {
        console.log(`🔍 Fetching videos for channel ID: ${CHANNEL_ID}...`);
        const response = await axios.get(`${CHANNEL_API}/${CHANNEL_ID}`);

        if (!response.data || !response.data.videos || response.data.videos.length === 0) {
            console.error("❌ No videos found for this channel.");
            process.exit(1);
        }

        const videoIds = response.data.videos;
        console.log(`📹 mujhe ${videoIds.length} videos mili h dekhta hu kitni bachi h`);

        for (const videoId of videoIds) {
            const filename = `${videoId}.webm`;
            const filePath = path.join(DOWNLOAD_DIR, filename);
            const fileUrl = `${FILE_BASE_URL}${filename}`;

            // Skip if already downloaded and valid
            if (downloadsData[videoId] && fs.existsSync(filePath) && downloadsData[videoId].size > 0) {
                console.log(`⏭️ isko ${videoId}, Skip kar rha hu kyoki sahi h`);
                continue;
            }

            console.log(`🎵 kisa download kar rha hu samjha kya ${videoId}...`);

            let success = false;
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    console.log(`🔄 Attempt ${attempt}/${MAX_RETRIES}...`);

                    // Get the download URL and filename from the MP3 API
                    const downloadResponse = await axios.get(`${MP3_API}/${videoId}`);
                    const { url, filename: videoTitle } = downloadResponse.data;

                    if (!url) {
                        throw new Error("phuck ho ga guru");
                    }

                    // Clean up filename to use as title (remove .mp3 extension if present)
                    const title = videoTitle 
                        ? videoTitle.replace(/\.mp3$/, '').trim() 
                        : `Video ${videoId}`;

                    // Download the audio file
                    const writer = fs.createWriteStream(filePath);
                    const audioResponse = await axios({
                        url,
                        method: "GET",
                        responseType: "stream",
                        timeout: 30000
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

                    console.log(`✅ kaam ho gya guru ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
                    console.log(`📝 Title from filename: ${title}`);

                    // Save to downloads.json with the filename as title
                    downloadsData[videoId] = {
                        title: title,
                        id: videoId,
                        filePath: fileUrl,
                        size: fileSize
                    };

                    fs.writeFileSync(DOWNLOADS_JSON, JSON.stringify(downloadsData, null, 2));

                    // Commit the file immediately
                    commitFile(filePath, videoId, title);
                    success = true;
                    break;
                } catch (err) {
                    console.error(`⚠️ phuck ho gya guru ${videoId}: ${err.message}`);
                    if (attempt === MAX_RETRIES) {
                        console.error(`❌ Failed after ${MAX_RETRIES} attempts, skipping.`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

            if (!success) {
                console.error(`🚨 Skipped: ${videoId} due to repeated errors.`);
            }
        }
    } catch (error) {
        console.error("❌ Error:", error.message);
    }
})();

function commitFile(filePath, videoId, title) {
    try {
        execSync("git config --global user.name 'github-actions'");
        execSync("git config --global user.email 'github-actions@github.com'");
        execSync(`git add "${filePath}" "${DOWNLOADS_JSON}"`);
        execSync(`git commit -m "Add downloaded audio: ${title} (${videoId})"`);
        execSync("git push");
        console.log(`📤 Committed and pushed ${filePath}`);
    } catch (err) {
        console.error("❌ Error committing file:", err.message);
    }
}
