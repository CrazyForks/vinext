import React from 'react'

export const metadata = {
  description: 'PayloadCMS running on vinext.',
  title: 'PayloadCMS + vinext',
}

export default function RootLayout(props: { children: React.ReactNode }) {
  const { children } = props

  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  )
}
