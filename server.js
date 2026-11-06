require("dotenv").config();

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

// Configure S3 Client with explicit credentials and region
const s3 = new S3Client({
  region: (process.env.AWS_REGION || "ap-southeast-2").trim(),
  credentials: (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID.trim(),
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY.trim()
  } : undefined
});

// In-memory cache for session uploads
const uploadedHistory = [];

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// API: Upload compressed image to S3
app.post("/api/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded." });

    const ext = path.extname(req.file.originalname).toLowerCase() || ".jpg";
    const baseClean = path.basename(req.file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, "");
    const key = `compressed/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${baseClean}${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
    }));

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: key
      }),
      { expiresIn: 3600 }
    );

    const uploadedItem = {
      key,
      name: req.file.originalname,
      size: req.file.size,
      lastModified: new Date().toISOString(),
      url
    };

    uploadedHistory.unshift(uploadedItem);

    res.json({ success: true, key, url, item: uploadedItem });
  } catch (err) {
    console.error("S3 Upload Error:", err);
    let errorMsg = err.message || "Upload failed. Check your AWS/S3 settings.";
    if (err.name === "AccessDenied") {
      errorMsg = "AWS AccessDenied: IAM user does not have 's3:PutObject' permission for bucket '" + (process.env.S3_BUCKET_NAME || "") + "'. Please attach AmazonS3FullAccess in AWS IAM console.";
    } else if (err.name === "NoSuchBucket") {
      errorMsg = `AWS Error: Bucket '${process.env.S3_BUCKET_NAME}' does not exist in region '${process.env.AWS_REGION}'.`;
    }
    res.status(500).json({ error: errorMsg, code: err.name });
  }
});

// API: List uploaded images from S3 (or fallback to local session history)
app.get("/api/images", async (req, res) => {
  try {
    if (!process.env.S3_BUCKET_NAME) {
      return res.json({ success: true, images: uploadedHistory });
    }

    const listCmd = new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET_NAME,
      Prefix: "compressed/",
      MaxKeys: 50
    });

    const s3Res = await s3.send(listCmd);
    const contents = s3Res.Contents || [];

    const files = contents.filter(item => item.Key && item.Key !== "compressed/");
    files.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));

    const images = await Promise.all(
      files.map(async (item) => {
        const getCmd = new GetObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: item.Key
        });
        const url = await getSignedUrl(s3, getCmd, { expiresIn: 3600 });
        const cleanName = item.Key.replace("compressed/", "").replace(/^\d+-[a-f0-9-]+-?/, "");

        return {
          key: item.Key,
          name: cleanName || item.Key.replace("compressed/", ""),
          size: item.Size,
          lastModified: item.LastModified,
          url
        };
      })
    );

    res.json({ success: true, images });
  } catch (err) {
    console.warn("S3 List Warning:", err.message);
    res.json({
      success: true,
      images: uploadedHistory,
      warning: err.name === "AccessDenied"
        ? "IAM Warning: 's3:ListBucket' permission is missing on IAM user. Showing session uploads."
        : err.message
    });
  }
});

// API: Delete an image from S3
app.delete("/api/images", async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: "Key is required" });

    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key
    }));

    const idx = uploadedHistory.findIndex(i => i.key === key);
    if (idx !== -1) uploadedHistory.splice(idx, 1);

    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    console.error("S3 Delete Error:", err);
    res.status(500).json({ error: err.message || "Failed to delete" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Running at http://localhost:${port}`));
