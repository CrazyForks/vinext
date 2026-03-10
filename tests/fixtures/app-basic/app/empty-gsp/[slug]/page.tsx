// Fixture for testing: generateStaticParams returning [] should produce a
// warning (not an error) and skip the route during static export.
export async function generateStaticParams() {
  return [];
}

export default function EmptyGspPage({ params }: { params: { slug: string } }) {
  return <div>Empty GSP: {params.slug}</div>;
}
