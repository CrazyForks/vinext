import { withPayload } from "@payloadcms/next/withPayload";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standard Next.js config
};

// withPayload wraps the config to handle Payload's package compatibility
export default withPayload(nextConfig, { devBundleServerPackages: false });
