import { Router } from 'express';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { successResponse, errorResponse } from '../utils/response.js';
import { ERROR_CODES } from '../types/error-constants.js';

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define available documentation files
const DOCS_MAP: Record<string, string> = {
  instructions: 'insforge-instructions.md',
  'db-api': 'insforge-db-api.md',
  'auth-api': 'insforge-auth-api.md',
  'storage-api': 'insforge-storage-api.md',
  debug: 'insforge-debug.md',
  project: 'insforge-project.md',
};

// GET /api/docs/:docType - Get specific documentation
router.get('/:docType', async (req, res, next) => {
  try {
    const { docType } = req.params;

    // Validate doc type
    const docFileName = DOCS_MAP[docType];
    if (!docFileName) {
      return errorResponse(res, ERROR_CODES.NOT_FOUND, 'Documentation not found', 404);
    }

    // Read the documentation file
    const filePath = path.resolve(__dirname, '../../docs', docFileName);
    const content = await readFile(filePath, 'utf-8');

    // Traditional REST: return documentation directly
    return successResponse(res, {
      type: docType,
      content,
    });
  } catch (error) {
    // If file doesn't exist or other error
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return errorResponse(res, ERROR_CODES.NOT_FOUND, 'Documentation file not found', 404);
    }
    next(error);
  }
});

// GET /api/docs - List available documentation
router.get('/', (_req, res) => {
  const available = Object.keys(DOCS_MAP).map((key) => ({
    type: key,
    filename: DOCS_MAP[key],
    endpoint: `/api/docs/${key}`,
  }));

  // Traditional REST: return list directly
  return successResponse(res, available);
});

export { router as docsRouter };
