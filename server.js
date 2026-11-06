require("dotenv").config();

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const {
  S3Client,
  PutObjectCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

const s3 = new S3Client({
  region: process.env.AWS_REGION
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

app.post("/api/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded." });

    const ext = path.extname(req.file.originalname).toLowerCase() || ".jpg";
    const key = `compressed/${Date.now()}-${crypto.randomUUID()}${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
    }));

    const url = await getSignedUrl(
      s3,
      new (require("@aws-sdk/client-s3").GetObjectCommand)({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: key
      }),
      { expiresIn: 3600 }
    );

    res.json({ success: true, key, url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed. Check your AWS/S3 settings." });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Running at http://localhost:${port}`));