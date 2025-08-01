import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseManager } from './database.js';
import { StorageRecord, StoredFile, BucketRecord } from '../types/storage.js';
import { MetadataService } from './metadata.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class StorageService {
  private static instance: StorageService;
  private readonly baseDir: string;

  private constructor() {
    this.baseDir = process.env.STORAGE_DIR || path.join(__dirname, '../../data/storage');
  }

  static getInstance(): StorageService {
    if (!StorageService.instance) {
      StorageService.instance = new StorageService();
    }
    return StorageService.instance;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  private getFilePath(bucket: string, key: string): string {
    // Simple file path: storage/bucket/key
    return path.join(this.baseDir, bucket, key);
  }

  private validateBucketName(bucket: string): void {
    // Simple validation: alphanumeric, hyphens, underscores
    if (!/^[a-zA-Z0-9_-]+$/.test(bucket)) {
      throw new Error('Invalid bucket name. Use only letters, numbers, hyphens, and underscores.');
    }
  }

  private validateKey(key: string): void {
    // Prevent directory traversal
    if (key.includes('..') || key.startsWith('/')) {
      throw new Error('Invalid key. Cannot use ".." or start with "/"');
    }
  }

  async putObject(bucket: string, key: string, file: Express.Multer.File): Promise<StoredFile> {
    this.validateBucketName(bucket);
    this.validateKey(key);

    const db = DatabaseManager.getInstance().getDb();

    // Check if file already exists
    const existing = await db
      .prepare('SELECT key FROM _storage WHERE bucket = ? AND key = ?')
      .get(bucket, key);

    if (existing) {
      throw new Error(`File "${key}" already exists in bucket "${bucket}"`);
    }

    const filePath = this.getFilePath(bucket, key);

    // Create bucket directory if needed
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Save file
    await fs.writeFile(filePath, file.buffer);

    // Save metadata to database
    await db
      .prepare(
        `
      INSERT INTO _storage (bucket, key, size, mime_type)
      VALUES (?, ?, ?, ?)
    `
      )
      .run(bucket, key, file.size, file.mimetype || null);

    // Get the actual uploaded_at timestamp from database
    const result = (await db
      .prepare('SELECT uploaded_at FROM _storage WHERE bucket = ? AND key = ?')
      .get(bucket, key)) as Pick<StorageRecord, 'uploaded_at'>;

    // Log the upload activity
    const dbManager = DatabaseManager.getInstance();
    await dbManager.logActivity('UPLOAD', `storage/${bucket}`, key, {
      size: file.size,
      mime_type: file.mimetype,
    });

    return {
      bucket,
      key,
      size: file.size,
      mime_type: file.mimetype,
      uploaded_at: result.uploaded_at,
      url: `/api/storage/${bucket}/${encodeURIComponent(key)}`,
    };
  }

  async getObject(
    bucket: string,
    key: string
  ): Promise<{ file: Buffer; metadata: StoredFile } | null> {
    this.validateBucketName(bucket);
    this.validateKey(key);

    const db = DatabaseManager.getInstance().getDb();

    const metadata = (await db
      .prepare('SELECT * FROM _storage WHERE bucket = ? AND key = ?')
      .get(bucket, key)) as StorageRecord | undefined;

    if (!metadata) {
      return null;
    }

    try {
      const filePath = this.getFilePath(bucket, key);
      const file = await fs.readFile(filePath);

      return {
        file,
        metadata: {
          ...metadata,
          url: `/api/storage/${bucket}/${encodeURIComponent(key)}`,
        },
      };
    } catch {
      return null;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<boolean> {
    this.validateBucketName(bucket);
    this.validateKey(key);

    const db = DatabaseManager.getInstance().getDb();

    try {
      // Delete file
      const filePath = this.getFilePath(bucket, key);
      await fs.unlink(filePath);
    } catch {
      // File might not exist, continue
    }

    // Get file info before deletion for logging
    const fileInfo = (await db
      .prepare('SELECT * FROM _storage WHERE bucket = ? AND key = ?')
      .get(bucket, key)) as StorageRecord | undefined;

    // Delete from database
    const result = await db
      .prepare('DELETE FROM _storage WHERE bucket = ? AND key = ?')
      .run(bucket, key);

    if (result.changes > 0 && fileInfo) {
      // Log the deletion activity
      const dbManager = DatabaseManager.getInstance();
      await dbManager.logActivity('DELETE', `storage/${bucket}`, key, {
        size: fileInfo.size,
        mime_type: fileInfo.mime_type,
      });
    }

    return result.changes > 0;
  }

  async listObjects(
    bucket: string,
    prefix?: string,
    limit: number = 100,
    offset: number = 0,
    searchQuery?: string
  ): Promise<{ objects: StoredFile[]; total: number }> {
    this.validateBucketName(bucket);

    const db = DatabaseManager.getInstance().getDb();

    let query = 'SELECT * FROM _storage WHERE bucket = ?';
    let countQuery = 'SELECT COUNT(*) as count FROM _storage WHERE bucket = ?';
    const params: (string | number)[] = [bucket];

    if (prefix) {
      query += ' AND key LIKE ?';
      countQuery += ' AND key LIKE ?';
      params.push(`${prefix}%`);
    }

    // Add search functionality for file names (key field)
    if (searchQuery && searchQuery.trim()) {
      query += ' AND key LIKE ?';
      countQuery += ' AND key LIKE ?';
      const searchPattern = `%${searchQuery.trim()}%`;
      params.push(searchPattern);
    }

    query += ' ORDER BY key LIMIT ? OFFSET ?';
    const queryParams = [...params, limit, offset];

    const objects = (await db.prepare(query).all(...queryParams)) as StorageRecord[];
    const total = ((await db.prepare(countQuery).get(...params)) as { count: number }).count;

    return {
      objects: objects.map((obj) => ({
        ...obj,
        url: `/api/storage/${bucket}/${encodeURIComponent(obj.key)}`,
      })),
      total,
    };
  }

  async isBucketPublic(bucket: string): Promise<boolean> {
    const db = DatabaseManager.getInstance().getDb();
    const result = (await db
      .prepare('SELECT public FROM _storage_buckets WHERE name = ?')
      .get(bucket)) as Pick<BucketRecord, 'public'> | undefined;
    return result?.public || false;
  }

  async updateBucketVisibility(bucket: string, isPublic: boolean): Promise<void> {
    const db = DatabaseManager.getInstance().getDb();

    // Check if bucket exists
    const bucketExists = await db
      .prepare('SELECT name FROM _storage_buckets WHERE name = ?')
      .get(bucket);

    if (!bucketExists) {
      throw new Error(`Bucket "${bucket}" does not exist`);
    }

    // Update bucket visibility in _storage_buckets table
    await db
      .prepare(
        'UPDATE _storage_buckets SET public = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?'
      )
      .run(isPublic, bucket);

    // Log visibility change
    const dbManager = DatabaseManager.getInstance();
    await dbManager.logActivity('UPDATE', 'storage', bucket, {
      type: 'bucket_visibility',
      public: isPublic,
    });

    // Update storage metadata
    await MetadataService.getInstance().updateStorageMetadata();
  }

  async listBuckets(): Promise<string[]> {
    const db = DatabaseManager.getInstance().getDb();

    // Get all buckets from _storage_buckets table
    const buckets = (await db
      .prepare('SELECT name FROM _storage_buckets ORDER BY name')
      .all()) as Pick<BucketRecord, 'name'>[];

    return buckets.map((b) => b.name);
  }

  async createBucket(bucket: string, isPublic: boolean = true): Promise<void> {
    this.validateBucketName(bucket);

    const db = DatabaseManager.getInstance().getDb();

    // Check if bucket already exists
    const existing = await db
      .prepare('SELECT name FROM _storage_buckets WHERE name = ?')
      .get(bucket);

    if (existing) {
      throw new Error(`Bucket "${bucket}" already exists`);
    }

    // Insert bucket into _storage_buckets table
    await db
      .prepare('INSERT INTO _storage_buckets (name, public) VALUES (?, ?)')
      .run(bucket, isPublic);

    // Create bucket directory
    const bucketPath = path.join(this.baseDir, bucket);
    await fs.mkdir(bucketPath, { recursive: true });

    // Log bucket creation
    const dbManager = DatabaseManager.getInstance();
    await dbManager.logActivity('CREATE', 'storage', bucket, { type: 'bucket', public: isPublic });

    // Update storage metadata
    await MetadataService.getInstance().updateStorageMetadata();
  }

  async deleteBucket(bucket: string): Promise<boolean> {
    this.validateBucketName(bucket);

    const db = DatabaseManager.getInstance().getDb();

    // Check if bucket exists
    const bucketExists = await db
      .prepare('SELECT name FROM _storage_buckets WHERE name = ?')
      .get(bucket);

    if (!bucketExists) {
      return false;
    }

    // Get all files in bucket
    const objects = (await db
      .prepare('SELECT key FROM _storage WHERE bucket = ?')
      .all(bucket)) as Pick<StorageRecord, 'key'>[];

    // Delete all files
    for (const obj of objects) {
      try {
        const filePath = this.getFilePath(bucket, obj.key);
        await fs.unlink(filePath);
      } catch {
        // Continue on error
      }
    }

    // Remove bucket directory
    try {
      await fs.rmdir(path.join(this.baseDir, bucket), { recursive: true });
    } catch {
      // Directory might not exist
    }

    // Delete from storage table (cascade will handle _storage entries)
    await db.prepare('DELETE FROM _storage_buckets WHERE name = ?').run(bucket);

    // Log bucket deletion
    const dbManager = DatabaseManager.getInstance();
    await dbManager.logActivity('DELETE', 'storage', bucket, {
      type: 'bucket',
      files_deleted: objects.length,
    });

    // Update storage metadata
    await MetadataService.getInstance().updateStorageMetadata();

    return true;
  }
}
