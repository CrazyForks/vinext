import { getPayload } from "payload";
import config from "@payload-config";

export default async function Home() {
  const payload = await getPayload({ config });

  // Fetch published posts from the Payload Local API
  const postsResult = await payload.find({
    collection: "posts",
    where: {
      status: {
        equals: "published",
      },
    },
    limit: 10,
  });

  return (
    <div>
      <h1 data-testid="heading">payload-cms test</h1>
      <p data-testid="ssr-content">Server-rendered content</p>
      <section data-testid="posts-list">
        <h2>Published Posts ({postsResult.totalDocs})</h2>
        <ul>
          {postsResult.docs.map((post) => (
            <li key={post.id} data-testid={`post-${post.id}`}>
              <span data-testid="post-title">{post.title}</span>
              {post.content && (
                <p data-testid="post-content">{post.content}</p>
              )}
            </li>
          ))}
        </ul>
      </section>
      <nav>
        <a href="/admin" data-testid="admin-link">
          Go to Admin
        </a>
      </nav>
    </div>
  );
}
