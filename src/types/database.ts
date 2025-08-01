// Type definitions for database schema management

// Column schema information from database
export interface ColumnSchema {
  name: string;
  type: string;
  nullable: boolean;
  default_value?: string;
  primary_key?: boolean;
  is_unique?: boolean;
  foreign_key?: {
    table: string;
    column: string;
    on_delete?: string;
    on_update?: string;
  };
}

// Table schema including columns and statistics
export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  record_count?: number | string;
  created_at?: string;
  updated_at?: string;
}

// Database schema containing all tables
export interface DatabaseSchema {
  tables: TableSchema[];
}

// Database metadata format returned by getDatabaseMetadata
export interface DatabaseMetadata {
  tables: Record<
    string,
    {
      columns: ColumnSchema[];
      record_count: number;
    }
  >;
}

export enum FieldType {
  STRING = 'string',
  DATETIME = 'datetime',
  INTEGER = 'integer',
  FLOAT = 'float',
  BOOLEAN = 'boolean',
  UUID = 'uuid',
  JSON = 'json',
}

export interface FieldTypeInfo {
  type: FieldType;
  sqlType: string;
  defaultValue: string | null;
  description: string;
  icon?: string;
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
  };
}

// Map frontend types to PostgreSQL types with metadata
export const FIELD_TYPES: Record<FieldType, FieldTypeInfo> = {
  [FieldType.STRING]: {
    type: FieldType.STRING,
    sqlType: 'TEXT',
    defaultValue: null,
    description: 'Text up to 255 characters',
    icon: 'text',
  },
  [FieldType.DATETIME]: {
    type: FieldType.DATETIME,
    sqlType: 'TIMESTAMPTZ',
    defaultValue: 'CURRENT_TIMESTAMP',
    description: 'Date and time with timezone',
    icon: 'calendar',
  },
  [FieldType.INTEGER]: {
    type: FieldType.INTEGER,
    sqlType: 'INTEGER',
    defaultValue: null,
    description: 'Whole numbers',
    icon: 'hash',
  },
  [FieldType.FLOAT]: {
    type: FieldType.FLOAT,
    sqlType: 'DOUBLE PRECISION',
    defaultValue: null,
    description: 'Decimal numbers with double precision',
    icon: 'percent',
  },
  [FieldType.BOOLEAN]: {
    type: FieldType.BOOLEAN,
    sqlType: 'BOOLEAN',
    defaultValue: 'false',
    description: 'True/false values',
    icon: 'toggle',
  },
  [FieldType.UUID]: {
    type: FieldType.UUID,
    sqlType: 'UUID',
    defaultValue: 'gen_random_uuid()',
    description: 'Unique identifier (auto-generated)',
    icon: 'fingerprint',
  },
  [FieldType.JSON]: {
    type: FieldType.JSON,
    sqlType: 'JSONB',
    defaultValue: null,
    description: 'Structured JSON data with indexing support',
    icon: 'code',
  },
};

export interface ForeignKeyDefinition {
  column: string;
  references_table: string;
  references_column: string;
  on_delete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  on_update?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
}

export interface ColumnDefinition {
  name: string;
  type: FieldType;
  nullable: boolean;
  unique?: boolean;
  default_value?: string;
  foreign_key?: {
    table: string;
    column: string;
    on_delete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    on_update?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  };
}

export interface CreateTableRequest {
  table_name: string;
  columns: ColumnDefinition[];
  rls_decl?: boolean; // Use RLS policies for this table
}

// Type definition for foreign key information
export interface ForeignKeyInfo {
  constraint_name: string;
  table: string;
  column: string;
  on_delete: string;
  on_update: string;
}

// Type definition for foreign key row from database
export interface ForeignKeyRow {
  constraint_name: string;
  from_column: string;
  foreign_table: string;
  foreign_column: string;
  on_delete: string;
  on_update: string;
}

// Type definition for column information from database
export interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
}

// Type definition for primary key information
export interface PrimaryKeyInfo {
  column_name: string;
}

// Valid types for database column values
export type DatabaseValue =
  | string
  | number
  | boolean
  | null
  | Date
  | DatabaseValue[]
  | { [key: string]: DatabaseValue }; // jsonB type

// Generic database record type - used when we don't know the exact table structure
export type DatabaseRecord = Record<string, DatabaseValue>;
