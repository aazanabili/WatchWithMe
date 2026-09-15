import type { Metadata } from 'next';
import RoomClient from '../../../components/room-client';
export const metadata: Metadata = {
  title: 'غرفة مشاهدة',
  description: undefined,
  robots: { index: false, follow: false, noarchive: true, noimageindex: true },
};
export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomClient roomId={roomId} />;
}
