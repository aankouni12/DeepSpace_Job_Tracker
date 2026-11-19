/** /home sends everyone to the board; signed-out visitors see the sign-in gate there. */

import { Navigate } from 'react-router-dom'

export default function HomePage() {
  return <Navigate to="/board" replace />
}
