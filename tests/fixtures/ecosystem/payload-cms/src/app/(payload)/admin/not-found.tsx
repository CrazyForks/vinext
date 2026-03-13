/* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. */
import config from '@payload-config'
import { NotFoundPage } from '@payloadcms/next/views'
import { importMap } from './importMap.js'

type Args = {
  params: Promise<{ segments: string[] }>
  searchParams: Promise<Record<string, string | string[]>>
}

export default function NotFound(args: Args) {
  return NotFoundPage({ config, importMap, ...args })
}
