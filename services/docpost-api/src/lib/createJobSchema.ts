import { z } from 'zod';
import { FOLDER_DESTINATION_REQUIRED } from '@docpost/shared';

const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
] as const;

export function totalSupportedDestinations(): number {
  const parsed = Number.parseInt(process.env.TOTAL_SUPPORTED_DESTINATIONS ?? '20', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 20;
  return parsed;
}

export function tooManyDestinationsMessage(limit = totalSupportedDestinations()): string {
  return `You can send to at most ${limit} destinations`;
}

function uniqueDestinationCount(
  destinations: Array<{ teamId: string; binderId: string; folderId?: unknown }>,
): number {
  const seen = new Set<string>();
  for (const destination of destinations) {
    if (typeof destination.folderId !== 'string' || destination.folderId.length === 0) continue;
    seen.add(`${destination.teamId}:${destination.binderId}:${destination.folderId}`);
  }
  return seen.size;
}

export const destinationSchema = z
  .object({
    teamId: z.string().uuid(),
    binderId: z.string().uuid(),
    folderId: z.unknown().optional(),
  })
  .superRefine((destination, ctx) => {
    if (typeof destination.folderId !== 'string' || destination.folderId.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: FOLDER_DESTINATION_REQUIRED,
        path: ['folderId'],
      });
      return;
    }
    if (!z.string().uuid().safeParse(destination.folderId).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose a folder in the selected binder',
        path: ['folderId'],
      });
    }
  });

const fileSchema = z.object({
  name: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(1).max(1_073_741_824),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  sha256: z.string().min(1),
});

const mappingSchema = z.object({
  fileIndex: z.number().int().min(0),
  destinations: z.array(destinationSchema).min(1),
});

export const createJobSchema = z
  .object({
    files: z.array(fileSchema).min(1).max(100),
    destinations: z.array(destinationSchema).min(1).max(500).optional(),
    mappings: z.array(mappingSchema).min(1).optional(),
  })
  .superRefine((data, ctx) => {
    const limit = totalSupportedDestinations();

    if (data.mappings?.length) {
      if (!data.mappings.every((mapping) => mapping.fileIndex < data.files.length)) {
        ctx.addIssue({ code: 'custom', message: 'fileIndex out of range' });
      }
      for (const [index, mapping] of data.mappings.entries()) {
        if (uniqueDestinationCount(mapping.destinations) > limit) {
          ctx.addIssue({
            code: 'custom',
            message: tooManyDestinationsMessage(limit),
            path: ['mappings', index, 'destinations'],
          });
        }
      }
      return;
    }
    if (!data.destinations?.length) {
      ctx.addIssue({ code: 'custom', message: 'Choose at least one destination' });
      return;
    }
    if (uniqueDestinationCount(data.destinations) > limit) {
      ctx.addIssue({
        code: 'custom',
        message: tooManyDestinationsMessage(limit),
        path: ['destinations'],
      });
    }
  });

export type JobDestination = {
  teamId: string;
  binderId: string;
  folderId: string;
};

export function parsedDestinations(
  destinations: Array<{ teamId: string; binderId: string; folderId?: unknown }>,
): JobDestination[] {
  return destinations.map((destination) => ({
    teamId: destination.teamId,
    binderId: destination.binderId,
    folderId: String(destination.folderId),
  }));
}
