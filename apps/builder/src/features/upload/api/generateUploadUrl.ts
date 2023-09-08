import { authenticatedProcedure } from '@/helpers/server/trpc'
import { z } from 'zod'
import { env } from '@typebot.io/env'
import { TRPCError } from '@trpc/server'
import { generatePresignedUrl } from '@typebot.io/lib/s3/generatePresignedUrl'
import prisma from '@/lib/prisma'
import { isWriteWorkspaceForbidden } from '@/features/workspace/helpers/isWriteWorkspaceForbidden'
import { isWriteTypebotForbidden } from '@/features/typebot/helpers/isWriteTypebotForbidden'

const inputSchema = z.object({
  filePathProps: z
    .object({
      workspaceId: z.string(),
      typebotId: z.string(),
      blockId: z.string(),
      itemId: z.string().optional(),
    })
    .or(
      z.object({
        workspaceId: z.string(),
        typebotId: z.string(),
        fileName: z.string(),
      })
    )
    .or(
      z.object({
        userId: z.string(),
        fileName: z.string(),
      })
    )
    .or(
      z.object({
        workspaceId: z.string(),
        fileName: z.string(),
      })
    ),
  fileType: z.string().optional(),
})

export type FilePathUploadProps = z.infer<
  typeof inputSchema.shape.filePathProps
>

export const generateUploadUrl = authenticatedProcedure
  .meta({
    openapi: {
      method: 'POST',
      path: '/generate-upload-url',
      summary: 'Generate upload URL',
      description: 'Generate the needed URL to upload a file from the client',
    },
  })
  .input(inputSchema)
  .output(
    z.object({
      presignedUrl: z.string(),
      fileUrl: z.string(),
    })
  )
  .mutation(async ({ input: { filePathProps, fileType }, ctx: { user } }) => {
    if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY)
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message:
          'S3 not properly configured. Missing one of those variables: S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY',
      })

    if ('resultId' in filePathProps && !user)
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You must be logged in to upload a file',
      })

    const filePath = await parseFilePath({
      authenticatedUserId: user?.id,
      uploadProps: filePathProps,
    })

    const presignedUrl = await generatePresignedUrl({
      fileType,
      filePath,
    })

    return {
      presignedUrl,
      fileUrl: env.S3_PUBLIC_CUSTOM_DOMAIN
        ? `${env.S3_PUBLIC_CUSTOM_DOMAIN}/${filePath}`
        : presignedUrl.split('?')[0],
    }
  })

type Props = {
  authenticatedUserId?: string
  uploadProps: FilePathUploadProps
}

const parseFilePath = async ({
  authenticatedUserId,
  uploadProps: input,
}: Props): Promise<string> => {
  if (!authenticatedUserId)
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to upload this type of file',
    })
  if ('userId' in input) {
    if (input.userId !== authenticatedUserId)
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You are not authorized to upload a file for this user',
      })
    return `public/users/${input.userId}/${input.fileName}`
  }
  if (!('workspaceId' in input))
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'workspaceId is missing',
    })
  if (!('typebotId' in input)) {
    const workspace = await prisma.workspace.findUnique({
      where: {
        id: input.workspaceId,
      },
      select: {
        members: {
          select: {
            userId: true,
            role: true,
          },
        },
      },
    })
    if (
      !workspace ||
      isWriteWorkspaceForbidden(workspace, { id: authenticatedUserId })
    )
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Workspace not found',
      })
    return `public/workspaces/${input.workspaceId}/${input.fileName}`
  }
  const typebot = await prisma.typebot.findUnique({
    where: {
      id: input.typebotId,
    },
    select: {
      workspaceId: true,
      collaborators: {
        select: {
          userId: true,
          type: true,
        },
      },
    },
  })
  if (
    !typebot ||
    (await isWriteTypebotForbidden(typebot, {
      id: authenticatedUserId,
    }))
  )
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Typebot not found',
    })
  if (!('blockId' in input)) {
    return `public/workspaces/${input.workspaceId}/typebots/${input.typebotId}/${input.fileName}`
  }
  return `public/workspaces/${input.workspaceId}/typebots/${
    input.typebotId
  }/blocks/${input.blockId}${input.itemId ? `/items/${input.itemId}` : ''}`
}