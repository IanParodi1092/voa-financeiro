import { z } from 'zod';
import type { PatchTarget } from '../db/patch.js';

/**
 * Contract of one PATCH route: the accepted body (zod, `partial` + `strict`), the explicit
 * `field -> column` map and the `RETURNING` projection.
 *
 * Structural keys stay out on purpose. `id`, `created_at` and the `legacy_*` columns belong to the
 * database and to the migration loader, `agreements.school_id|customer_id` and
 * `installments.agreement_id` describe the shape of the financial chain (moving them would orphan
 * the rows underneath), and `installments.installment_number` is half of a unique key.
 */
export interface PatchSpec extends PatchTarget {
  /** Plural table name: used in messages and as the audit `entity_type`. */
  entityType: string;
  /** Audit action, e.g. `customer.updated`. */
  auditAction: string;
  schema: z.ZodType<Record<string, unknown>>;
  /** API field -> column. Nothing reaches the `SET` clause without passing through this map. */
  columns: Record<string, string>;
}

/** Free-form lifecycle label: the schema has no CHECK for `status`, only a default. */
const status = z.string().trim().min(1).max(30);
const text = (max: number) => z.string().trim().min(1).max(max);
/** Nullable text: sending `null` clears the column; sending `""` is rejected. */
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable();
const retentionStatus = z.enum(['pending_approval', 'approved', 'released', 'not_applicable', 'direct_payment']);

export const patchSpecs = {
  schools: {
    table: 'schools',
    softDelete: true,
    entityType: 'schools',
    auditAction: 'school.updated',
    returning: `id, legal_name AS "legalName", trade_name AS "tradeName", document_number AS "documentNumber", status,
      retention_enabled AS "retentionEnabled", retention_target_amount AS "retentionTargetAmount",
      created_at AS "createdAt", updated_at AS "updatedAt"`,
    schema: z.object({
      legalName: text(200).min(2),
      tradeName: nullableText(200),
      documentNumber: nullableText(30),
      status,
      retentionEnabled: z.boolean(),
      retentionTargetAmount: z.number().nonnegative().nullable()
    }).partial().strict(),
    columns: {
      legalName: 'legal_name',
      tradeName: 'trade_name',
      documentNumber: 'document_number',
      status: 'status',
      retentionEnabled: 'retention_enabled',
      retentionTargetAmount: 'retention_target_amount'
    }
  },
  customers: {
    table: 'customers',
    softDelete: true,
    entityType: 'customers',
    auditAction: 'customer.updated',
    returning: `id, full_name AS "fullName", document_number AS "documentNumber", email, phone, status,
      created_at AS "createdAt", updated_at AS "updatedAt"`,
    schema: z.object({
      fullName: text(200).min(2),
      documentNumber: nullableText(30),
      email: z.string().email().transform((value) => value.toLowerCase()).nullable(),
      phone: nullableText(30),
      status
    }).partial().strict(),
    columns: {
      fullName: 'full_name',
      documentNumber: 'document_number',
      email: 'email',
      phone: 'phone',
      status: 'status'
    }
  },
  students: {
    table: 'students',
    softDelete: true,
    entityType: 'students',
    auditAction: 'student.updated',
    returning: `id, school_id AS "schoolId", customer_id AS "customerId", full_name AS "fullName",
      document_number AS "documentNumber", enrollment_number AS "enrollmentNumber", status,
      created_at AS "createdAt", updated_at AS "updatedAt"`,
    schema: z.object({
      schoolId: z.string().uuid(),
      customerId: z.string().uuid().nullable(),
      fullName: text(200).min(2),
      documentNumber: nullableText(30),
      enrollmentNumber: nullableText(50),
      status
    }).partial().strict(),
    columns: {
      schoolId: 'school_id',
      customerId: 'customer_id',
      fullName: 'full_name',
      documentNumber: 'document_number',
      enrollmentNumber: 'enrollment_number',
      status: 'status'
    }
  },
  agreements: {
    table: 'agreements',
    softDelete: true,
    entityType: 'agreements',
    auditAction: 'agreement.updated',
    returning: `id, school_id AS "schoolId", customer_id AS "customerId", student_id AS "studentId", reference,
      total_amount AS "totalAmount", installments_count AS "installmentsCount", status,
      created_at AS "createdAt", updated_at AS "updatedAt"`,
    schema: z.object({
      studentId: z.string().uuid().nullable(),
      reference: nullableText(200),
      totalAmount: z.number().nonnegative(),
      installmentsCount: z.number().int().positive().max(120),
      status
    }).partial().strict(),
    columns: {
      studentId: 'student_id',
      reference: 'reference',
      totalAmount: 'total_amount',
      installmentsCount: 'installments_count',
      status: 'status'
    }
  },
  installments: {
    table: 'installments',
    softDelete: true,
    entityType: 'installments',
    auditAction: 'installment.updated',
    returning: `id, agreement_id AS "agreementId", installment_number AS "installmentNumber",
      due_date AS "dueDate", original_amount AS "originalAmount", status,
      created_at AS "createdAt", updated_at AS "updatedAt"`,
    schema: z.object({
      dueDate: z.string().date(),
      originalAmount: z.number().nonnegative(),
      status
    }).partial().strict(),
    columns: {
      dueDate: 'due_date',
      originalAmount: 'original_amount',
      status: 'status'
    }
  },
  payments: {
    table: 'payments',
    softDelete: false,
    entityType: 'payments',
    auditAction: 'payment.updated',
    returning: `id, installment_id AS "installmentId", amount, retained_amount AS "retainedAmount",
      released_amount AS "releasedAmount", paid_at AS "paidAt", status, source, external_id AS "externalId",
      retention_status AS "retentionStatus", retention_percentage AS "retentionPercentage",
      retention_approved_at AS "retentionApprovedAt", retention_scheduled_month AS "retentionScheduledMonth",
      retention_released_at AS "retentionReleasedAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
    schema: z.object({
      status,
      retainedAmount: z.number().nonnegative(),
      releasedAmount: z.number().nonnegative(),
      retentionStatus: retentionStatus.nullable(),
      /** Fraction of the payment (0.25 = 25%), matching the numeric(5, 4) column of migration 0008. */
      retentionPercentage: z.number().min(0).max(1).nullable(),
      retentionApprovedAt: z.string().date().nullable(),
      /** `AAAA-MM`, the only shape the CHECK of `retention_scheduled_month` accepts. */
      retentionScheduledMonth: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/u).nullable(),
      retentionReleasedAt: z.string().date().nullable()
    }).partial().strict(),
    columns: {
      status: 'status',
      retainedAmount: 'retained_amount',
      releasedAmount: 'released_amount',
      retentionStatus: 'retention_status',
      retentionPercentage: 'retention_percentage',
      retentionApprovedAt: 'retention_approved_at',
      retentionScheduledMonth: 'retention_scheduled_month',
      retentionReleasedAt: 'retention_released_at'
    }
  }
} as const satisfies Record<string, PatchSpec>;

export type PatchEntity = keyof typeof patchSpecs;
