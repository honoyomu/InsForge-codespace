import { Router, Response, NextFunction } from 'express';
import { DatabaseManager } from '../services/database.js';
import { MetadataService } from '../services/metadata.js';
import { verifyUserOrApiKey, AuthRequest } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { successResponse } from '../utils/response.js';
import { ERROR_CODES } from '../types/error-constants.js';
import {
  FIELD_TYPES,
  CreateTableRequest,
  ColumnDefinition,
  FieldType,
  ForeignKeyInfo,
  ForeignKeyRow,
  ColumnInfo,
  PrimaryKeyInfo,
} from '../types/database.js';
import { validateIdentifier } from '../utils/validations.js';

// Helper function to quote identifiers for SQL
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

// Helper function to validate and filter reserved fields
function validateReservedFields(columns: ColumnDefinition[]): ColumnDefinition[] {
  const reservedFields = {
    id: 'uuid',
    created_at: 'datetime',
    updated_at: 'datetime',
  };
  return columns.filter((col: ColumnDefinition) => {
    const reservedType = reservedFields[col.name.toLowerCase() as keyof typeof reservedFields];
    if (reservedType) {
      // If it's a reserved field name
      if (col.type === reservedType) {
        // Type matches - silently ignore this column
        return false;
      } else {
        // Type doesn't match - throw error
        throw new AppError(
          `Column '${col.name}' is a reserved field that requires type '${reservedType}', but got '${col.type}'`,
          400,
          ERROR_CODES.DATABASE_VALIDATION_ERROR,
          'Please check the column name and type, id/created_at/updated_at are reserved fields and cannot be used as column names'
        );
      }
    }
    return true;
  });
}

const router = Router();

// All table routes accept either JWT token or API key authentication
router.use(verifyUserOrApiKey);

// Table management routes
router.get('/', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const dbManager = DatabaseManager.getInstance();
    const db = dbManager.getAppDb();

    const tables = await db
      .prepare(
        `
      SELECT table_name as name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE '\\_%'
    `
      )
      .all();

    successResponse(
      res,
      tables.map((t: { name: string }) => t.name)
    );
  } catch (error) {
    next(error);
  }
});

function generateFkeyConstraintStatement(
  col: ColumnDefinition,
  include_source_column: boolean = true
) {
  if (!col.foreign_key) {
    return '';
  }
  // Store foreign_key in a const to avoid repeated non-null assertions
  const fk = col.foreign_key;
  const constraintName = `fk_${col.name}_${fk.table}_${fk.column}`;
  const onDelete = fk.on_delete || 'RESTRICT';
  const onUpdate = fk.on_update || 'RESTRICT';

  if (include_source_column) {
    return `CONSTRAINT ${quoteIdentifier(constraintName)} FOREIGN KEY (${quoteIdentifier(col.name)}) REFERENCES ${quoteIdentifier(fk.table)}(${quoteIdentifier(fk.column)}) ON DELETE ${onDelete} ON UPDATE ${onUpdate}`;
  } else {
    return `CONSTRAINT ${quoteIdentifier(constraintName)} REFERENCES ${quoteIdentifier(fk.table)}(${quoteIdentifier(fk.column)}) ON DELETE ${onDelete} ON UPDATE ${onUpdate}`;
  }
}

async function getFkeyConstraints(table: string): Promise<Map<string, ForeignKeyInfo>> {
  const dbManager = DatabaseManager.getInstance();
  const db = dbManager.getAppDb();
  const foreignKeys = await db
    .prepare(
      `
    SELECT
      tc.constraint_name,
      kcu.column_name as from_column,
      ccu.table_name AS foreign_table,
      ccu.column_name AS foreign_column,
      rc.delete_rule as on_delete,
      rc.update_rule as on_update
    FROM information_schema.table_constraints AS tc 
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    JOIN information_schema.referential_constraints AS rc
      ON rc.constraint_name = tc.constraint_name
      AND rc.constraint_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' 
    AND tc.table_name = ?
  `
    )
    .all(table);

  // Create a map of column names to their foreign key info
  const foreignKeyMap = new Map<string, ForeignKeyInfo>();
  foreignKeys.forEach((fk: ForeignKeyRow) => {
    foreignKeyMap.set(fk.from_column, {
      constraint_name: fk.constraint_name,
      table: fk.foreign_table,
      column: fk.foreign_column,
      on_delete: fk.on_delete,
      on_update: fk.on_update,
    });
  });
  return foreignKeyMap;
}

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const requestData: CreateTableRequest = req.body;
    const { table_name, columns, rls_decl } = requestData;

    let use_RLS = true; // Default to true if not provided
    if (rls_decl !== undefined) {
      use_RLS = rls_decl;
    }

    // Validate required fields
    if (!table_name || !columns || !Array.isArray(columns)) {
      throw new AppError(
        'table_name and columns array are required',
        400,
        ERROR_CODES.MISSING_FIELD,
        'table_name and columns array are required. Please check the request body, table_name and columns are required'
      );
    }

    // Validate table name
    validateIdentifier(table_name, 'table');
    // Prevent creation of system tables
    if (table_name.startsWith('_')) {
      throw new AppError(
        'Cannot create system tables',
        403,
        ERROR_CODES.FORBIDDEN,
        'Table names starting with underscore are reserved for system tables'
      );
    }

    // Filter out reserved fields with matching types, throw error for mismatched types
    const validatedColumns = validateReservedFields(columns);

    // Validate remaining columns
    validatedColumns.forEach((col: ColumnDefinition, index: number) => {
      // Validate column name
      try {
        validateIdentifier(col.name, 'column');
      } catch (error) {
        if (error instanceof AppError) {
          throw new AppError(
            `Invalid column name at index ${index}: ${error.message}`,
            error.statusCode,
            error.code,
            error.nextAction
          );
        }
        throw error;
      }

      // Validate column type
      if (!col.type || !(col.type in FIELD_TYPES)) {
        throw new AppError(
          `Invalid type at index ${index}: ${col.type}. Allowed types: ${Object.keys(FIELD_TYPES).join(', ')}`,
          400,
          ERROR_CODES.DATABASE_VALIDATION_ERROR,
          'Please check the column type, it must be one of the allowed types: ' +
            Object.keys(FIELD_TYPES).join(', ')
        );
      }

      // Validate nullable is boolean
      if (typeof col.nullable !== 'boolean') {
        throw new AppError(
          `Column 'nullable' must be a boolean at index ${index}`,
          400,
          ERROR_CODES.DATABASE_VALIDATION_ERROR,
          `Column 'nullable' must be a boolean at index ${index}. Please check the column nullable, it must be a boolean.`
        );
      }
    });

    const dbManager = DatabaseManager.getInstance();
    const db = dbManager.getAppDb();

    // Check if table exists
    const tableExists = await db
      .prepare(
        `
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = ?
      ) as exists
    `
      )
      .get(table_name);

    if (tableExists?.exists) {
      throw new AppError(
        `table ${table_name} already exists`,
        400,
        ERROR_CODES.DATABASE_DUPLICATE,
        `table ${table_name} already exists. Please check the table name, it must be a unique table name.`
      );
    }
    // Map columns to SQL with proper type conversion
    const columnDefs = validatedColumns
      .map((col: ColumnDefinition) => {
        const fieldType = FIELD_TYPES[col.type];
        const sqlType = fieldType.sqlType;

        // Handle default values
        let defaultClause = '';
        if (col.default_value) {
          // User-specified default
          defaultClause = `DEFAULT '${col.default_value}'`;
        } else if (fieldType.defaultValue && !col.nullable) {
          // Type-specific default for non-nullable fields
          if (fieldType.defaultValue === 'gen_random_uuid()' && col.type === 'uuid') {
            // PostgreSQL UUID generation
            defaultClause = `DEFAULT gen_random_uuid()`;
          } else if (fieldType.defaultValue === 'CURRENT_TIMESTAMP') {
            defaultClause = `DEFAULT CURRENT_TIMESTAMP`;
          } else {
            defaultClause = `DEFAULT ${fieldType.defaultValue}`;
          }
        }

        const nullable = col.nullable ? '' : 'NOT NULL';
        const unique = col.unique ? 'UNIQUE' : '';

        return `${quoteIdentifier(col.name)} ${sqlType} ${nullable} ${unique} ${defaultClause}`.trim();
      })
      .join(', ');

    // Prepare foreign key constraints
    const foreignKeyConstraints = validatedColumns
      .filter((col) => col.foreign_key)
      .map((col) => generateFkeyConstraintStatement(col, true))
      .join(', ');

    // Create table with auto fields and foreign keys
    const tableDefinition = [
      'id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
      columnDefs,
      'created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP',
      'updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP',
      foreignKeyConstraints,
    ]
      .filter(Boolean)
      .join(', ');

    await db
      .prepare(
        `
      CREATE TABLE ${quoteIdentifier(table_name)} (
        ${tableDefinition}
      )
    `
      )
      .exec();

    // enable postgrest to query this table
    await db
      .prepare(
        `
      GRANT SELECT,INSERT,UPDATE,DELETE ON ${quoteIdentifier(table_name)} TO web_anon;
      NOTIFY pgrst, 'reload schema';
    `
      )
      .exec();

    if (use_RLS) {
      // Enable RLS policies
      await db
        .prepare(
          `
        ALTER TABLE ${quoteIdentifier(table_name)} ENABLE ROW LEVEL SECURITY;
      `
        )
        .exec();

      // Create a policy to allow all users to select
      await db
        .prepare(
          `
        CREATE POLICY "web_anon_policy" ON ${quoteIdentifier(table_name)}
          FOR ALL TO web_anon USING (true) WITH CHECK (true);
      `
        )
        .exec();
    }

    // Create trigger for updated_at
    await db
      .prepare(
        `
      CREATE TRIGGER ${quoteIdentifier(table_name + '_update_timestamp')} 
      BEFORE UPDATE ON ${quoteIdentifier(table_name)}
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `
      )
      .exec();

    // Log the table creation activity
    await DatabaseManager.getInstance().logActivity('CREATE_TABLE', table_name, undefined, {
      columns: validatedColumns,
    });

    // Update metadata
    const metadataService = MetadataService.getInstance();
    await metadataService.updateDatabaseMetadata();

    successResponse(
      res,
      {
        message: 'table created successfully',
        table_name,
        columns: validatedColumns.map((col) => ({
          ...col,
          sql_type: FIELD_TYPES[col.type].sqlType,
        })),
        auto_fields: ['id', 'created_at', 'updated_at'],
        nextAction: 'you can now use the table with the POST /api/database/tables/{table} endpoint',
      },
      201
    );
  } catch (error) {
    next(error);
  }
});

router.get('/:table/schema', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { table } = req.params;

    const dbManager = DatabaseManager.getInstance();
    const db = dbManager.getAppDb();

    // Get column information from information_schema
    const columns = await db
      .prepare(
        `
      SELECT 
        column_name,
        data_type,
        is_nullable,
        column_default,
        character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public' 
      AND table_name = ?
      ORDER BY ordinal_position
    `
      )
      .all(table);

    if (columns.length === 0) {
      throw new AppError(
        'table not found',
        404,
        ERROR_CODES.DATABASE_NOT_FOUND,
        'table not found. Please check the table name, it must be a valid table name, or you can create a new table with the POST /api/database/tables endpoint'
      );
    }

    // Get foreign key information
    const foreignKeyMap = await getFkeyConstraints(table);

    // Get primary key information
    const primaryKeys = await db
      .prepare(
        `
      SELECT column_name
      FROM information_schema.key_column_usage
      WHERE table_schema = 'public'
      AND table_name = ?
      AND constraint_name = (
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_schema = 'public'
        AND table_name = ?
        AND constraint_type = 'PRIMARY KEY'
      )
    `
      )
      .all(table, table);

    const pkSet = new Set(primaryKeys.map((pk: PrimaryKeyInfo) => pk.column_name));

    // Get unique columns
    const uniqueColumns = await db
      .prepare(
        `
      SELECT DISTINCT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = ?
        AND tc.constraint_type = 'UNIQUE'
    `
      )
      .all(table);

    const uniqueSet = new Set(uniqueColumns.map((u: { column_name: string }) => u.column_name));

    successResponse(res, {
      table_name: table,
      columns: columns.map((col: ColumnInfo) => ({
        name: col.column_name,
        type: col.data_type,
        nullable: col.is_nullable === 'YES',
        primary_key: pkSet.has(col.column_name),
        unique: pkSet.has(col.column_name) || uniqueSet.has(col.column_name),
        default_value: col.column_default,
        ...(foreignKeyMap.has(col.column_name) && {
          foreign_key: foreignKeyMap.get(col.column_name),
        }),
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/:table', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { table } = req.params;
    const { add_columns, drop_columns, rename_columns, add_fkey_columns, drop_fkey_columns } =
      req.body;

    // Prevent modification of system tables
    if (table.startsWith('_')) {
      throw new AppError(
        'System tables cannot be modified',
        403,
        ERROR_CODES.DATABASE_FORBIDDEN,
        'System tables cannot be modified. System tables are prefixed with underscore.'
      );
    }

    if (
      !add_columns &&
      !drop_columns &&
      !rename_columns &&
      !add_fkey_columns &&
      !drop_fkey_columns
    ) {
      throw new AppError(
        'At least one operation (add_columns, drop_columns, rename_columns, add_fkey_columns, drop_fkey_columns) is required',
        400,
        ERROR_CODES.MISSING_FIELD,
        'Please check the request body, at least one operation(add_columns, drop_columns, rename_columns, add_fkey_columns, drop_fkey_columns) is required'
      );
    }

    const dbManager = DatabaseManager.getInstance();
    const db = dbManager.getAppDb();

    // Check if table exists
    const tableExists = await db
      .prepare(
        `
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = ?
      ) as exists
    `
      )
      .get(table);

    if (!tableExists?.exists) {
      throw new AppError(
        'table not found',
        404,
        ERROR_CODES.DATABASE_NOT_FOUND,
        'Please check the table name, it must be a valid table name, or you can create a new table with the POST /api/database/tables endpoint'
      );
    }

    const tableColumns = await db
      .prepare(
        `
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ?
    `
      )
      .all(table);
    const columnSet = new Set(tableColumns.map((c: { column_name: string }) => c.column_name));

    // Create a working copy of columnSet to track state changes during validation
    const workingColumnSet = new Set(columnSet);

    // Get foreign key information
    const foreignKeyMap = await getFkeyConstraints(table);

    if (add_fkey_columns && Array.isArray(add_fkey_columns)) {
      for (const col of add_fkey_columns) {
        if (!col.name) {
          throw new AppError(
            'Source Column name are required',
            400,
            ERROR_CODES.MISSING_FIELD,
            'Please check the request body, column name are required'
          );
        }
        if (!col.foreign_key || !col.foreign_key.table || !col.foreign_key.column) {
          throw new AppError(
            'Target table/column are required',
            400,
            ERROR_CODES.MISSING_FIELD,
            'Please check the request body, target table/column are required.'
          );
        }
        if (foreignKeyMap.has(col.name)) {
          throw new AppError(
            `Foreigh Key on Column(${col.name}) already exists`,
            400,
            ERROR_CODES.DATABASE_VALIDATION_ERROR,
            `Foreigh Key on Column(${col.name}) already exists. Please check the schema with GET /api/database/tables/${table}/schema endpoint.`
          );
        }
      }
    }

    if (drop_fkey_columns && Array.isArray(drop_fkey_columns)) {
      for (const col of drop_fkey_columns) {
        if (!col.name) {
          throw new AppError('Column name are required', 400, ERROR_CODES.MISSING_FIELD);
        }
        if (!columnSet.has(col.name)) {
          throw new AppError(
            `Column(${col.name}) not found`,
            404,
            ERROR_CODES.DATABASE_NOT_FOUND,
            `Column(${col.name}) not found. Please check the schema with GET /api/tables/${table}/schema endpoint.`
          );
        }
        if (!foreignKeyMap.has(col.name)) {
          throw new AppError(
            `Foreign Key Constraint on Column(${col.name}) not found`,
            404,
            ERROR_CODES.DATABASE_NOT_FOUND,
            `Foreign Key Constraint on Column(${col.name}) not found. Please check the schema with GET /api/tables/${table}/schema endpoint.`
          );
        }
      }
    }

    // First, validate and simulate drop columns (these happen first)
    if (drop_columns && Array.isArray(drop_columns)) {
      for (const col of drop_columns) {
        if (!col.name) {
          throw new AppError('Column name are required', 400, ERROR_CODES.MISSING_FIELD);
        }
        if (!workingColumnSet.has(col.name)) {
          throw new AppError(
            `Column(${col.name}) not found`,
            404,
            ERROR_CODES.DATABASE_NOT_FOUND,
            `Column(${col.name}) not found. Please check the schema with GET /api/database/tables/${table}/schema endpoint.`
          );
        }
        // Remove from working set to simulate the drop
        workingColumnSet.delete(col.name);
      }
    }

    if (add_columns && Array.isArray(add_columns)) {
      for (const col of add_columns) {
        if (!col.name || !col.type) {
          throw new AppError('Column name and type are required', 400, ERROR_CODES.MISSING_FIELD);
        }

        const fieldType = FIELD_TYPES[col.type as FieldType];
        if (!fieldType) {
          throw new AppError(
            `Invalid column type: ${col.type}`,
            400,
            ERROR_CODES.DATABASE_VALIDATION_ERROR,
            'Please check the column type, it must be one of the allowed types: ' +
              Object.keys(FIELD_TYPES).join(', ')
          );
        }

        if (workingColumnSet.has(col.name)) {
          throw new AppError(
            `Column(${col.name}) already exists`,
            400,
            ERROR_CODES.DATABASE_VALIDATION_ERROR,
            `Column(${col.name}) already exists. Please check the schema with GET /api/database/tables/${table}/schema endpoint.`
          );
        }
        // Add to working set to simulate the add
        workingColumnSet.add(col.name);
      }
    }
    if (rename_columns && typeof rename_columns === 'object') {
      for (const [oldName, newName] of Object.entries(rename_columns)) {
        if (!oldName || !newName) {
          throw new AppError('Old name and new name are required', 400, ERROR_CODES.MISSING_FIELD);
        }
        if (!workingColumnSet.has(oldName)) {
          throw new AppError(
            `Column(${oldName}) not found`,
            404,
            ERROR_CODES.DATABASE_NOT_FOUND,
            `Column(${oldName}) not found. Please check the schema with GET /api/database/tables/${table}/schema endpoint.`
          );
        }
        if (workingColumnSet.has(newName as string)) {
          throw new AppError(
            `Column(${newName}) already exists`,
            400,
            ERROR_CODES.DATABASE_VALIDATION_ERROR,
            `Column(${newName}) already exists. Please check the schema with GET /api/database/tables/${table}/schema endpoint.`
          );
        }
        // Simulate the rename
        workingColumnSet.delete(oldName);
        workingColumnSet.add(newName as string);
      }
    }

    const operations = [];

    // Drop columns first (to avoid conflicts with renames)
    if (drop_columns && Array.isArray(drop_columns)) {
      for (const col of drop_columns) {
        await db
          .prepare(
            `
          ALTER TABLE ${quoteIdentifier(table)} 
          DROP COLUMN ${quoteIdentifier(col.name)}
        `
          )
          .exec();

        operations.push(`Dropped column: ${col.name}`);
      }
    }

    // Add new columns
    if (add_columns && Array.isArray(add_columns)) {
      // Validate and filter reserved fields
      const columnsToAdd = validateReservedFields(add_columns);

      for (const col of columnsToAdd) {
        const fieldType = FIELD_TYPES[col.type as FieldType];
        let sqlType = fieldType.sqlType;
        if (col.type === 'uuid') {
          sqlType = 'UUID';
        }

        const nullable = col.nullable !== false ? '' : 'NOT NULL';
        let defaultClause = '';

        if (col.default_value !== undefined) {
          defaultClause = `DEFAULT ${col.default_value}`;
        } else if (col.nullable === false && fieldType.defaultValue) {
          if (fieldType.defaultValue === 'gen_random_uuid()' && col.type === 'uuid') {
            defaultClause = 'DEFAULT gen_random_uuid()';
          } else {
            defaultClause = `DEFAULT ${fieldType.defaultValue}`;
          }
        }
        if (col.foreign_key) {
          // Add foreign key constraint
          const fkeyConstraints = generateFkeyConstraintStatement(col, false);
          if (fkeyConstraints) {
            defaultClause += ` ${fkeyConstraints}`;
          }
        }

        await db
          .prepare(
            `
          ALTER TABLE ${quoteIdentifier(table)} 
          ADD COLUMN ${quoteIdentifier(col.name)} ${sqlType} ${nullable} ${defaultClause}
        `
          )
          .exec();

        operations.push(`Added column: ${col.name}`);
      }
    }

    // Rename columns (SQLite 3.25.0+ supports this)
    if (rename_columns && typeof rename_columns === 'object') {
      for (const [oldName, newName] of Object.entries(rename_columns)) {
        await db
          .prepare(
            `
          ALTER TABLE ${quoteIdentifier(table)} 
          RENAME COLUMN ${quoteIdentifier(oldName)} TO ${quoteIdentifier(newName as string)}
        `
          )
          .exec();

        operations.push(`Renamed column: ${oldName} → ${newName}`);
      }
    }

    if (add_fkey_columns && Array.isArray(add_fkey_columns)) {
      for (const col of add_fkey_columns) {
        const fkeyConstraint = generateFkeyConstraintStatement(col, true);
        await db
          .prepare(
            `
          ALTER TABLE ${quoteIdentifier(table)} 
          ADD ${fkeyConstraint}
        `
          )
          .exec();

        operations.push(`Added foreign key constraint on column: ${col.name}`);
      }
    }

    if (drop_fkey_columns && Array.isArray(drop_fkey_columns)) {
      for (const col of drop_fkey_columns) {
        const constraintName = foreignKeyMap.get(col.name)?.constraint_name;
        if (constraintName) {
          await db
            .prepare(
              `
            ALTER TABLE ${quoteIdentifier(table)} 
            DROP CONSTRAINT ${quoteIdentifier(constraintName)}
          `
            )
            .exec();

          operations.push(`Dropped foreign key constraint on column: ${col.name}`);
        }
      }
    }

    // Update metadata after schema changes
    const metadataService = MetadataService.getInstance();
    await metadataService.updateDatabaseMetadata();
    // enable postgrest to query this table
    await db
      .prepare(
        `
      NOTIFY pgrst, 'reload schema';
    `
      )
      .exec();

    successResponse(res, {
      message: 'table schema updated successfully',
      table_name: table,
      operations,
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/:table', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { table } = req.params;

    // Prevent deletion of system tables
    if (table.startsWith('_')) {
      throw new AppError(
        'System tables cannot be deleted',
        403,
        ERROR_CODES.DATABASE_FORBIDDEN,
        'System tables cannot be deleted. System tables are prefixed with underscore.'
      );
    }

    const dbManager = DatabaseManager.getInstance();
    const db = dbManager.getAppDb();

    await db.prepare(`DROP TABLE IF EXISTS ${quoteIdentifier(table)} CASCADE`).run();

    // Update metadata
    const metadataService = MetadataService.getInstance();
    await metadataService.updateDatabaseMetadata();
    // enable postgrest to query this table
    await db
      .prepare(
        `
      NOTIFY pgrst, 'reload schema';
    `
      )
      .exec();

    successResponse(
      res,
      {
        message: 'table deleted successfully',
        table_name: table,
        nextAction:
          'table deleted successfully, you can create a new table with the POST /api/database/tables endpoint',
      },
      200
    );
  } catch (error) {
    next(error);
  }
});

export { router as tablesRouter };
