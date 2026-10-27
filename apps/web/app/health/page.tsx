export default function Health() {
  return <pre>{JSON.stringify({ status: "ok", service: "web" })}</pre>;
}
