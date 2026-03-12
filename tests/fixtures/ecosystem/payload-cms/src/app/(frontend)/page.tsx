import { getPayload } from 'payload'
import React from 'react'

import config from '@/payload.config'

export default async function HomePage() {
  const payloadConfig = await config
  const payload = await getPayload({ config: payloadConfig })

  const posts = await payload.find({
    collection: 'posts',
    limit: 10,
  })

  return (
    <div>
      <h1>PayloadCMS + vinext</h1>
      <p>Posts count: {posts.totalDocs}</p>
      <ul>
        {posts.docs.map((post) => (
          <li key={post.id}>{post.title}</li>
        ))}
      </ul>
      <a href="/admin">Go to admin panel</a>
    </div>
  )
}
