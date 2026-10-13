import { createSocket } from "node:dgram";
import { PortMapError } from "./pcp.js";

// UPnP Internet Gateway Device, the fallback for routers without NAT-PMP or
// PCP (Agent Note 2026-10-13-media-off-the-worker): SSDP finds the router's
// description, and SOAP calls on its WANIPConnection (or WANPPPConnection)
// service read the public address and add or delete one TCP port mapping.
// Only a description served from the default gateway's own address is used,
// so another device on the LAN that answers SSDP cannot take the mapping.

export const SSDP_ADDRESS = "239.255.255.250";
export const SSDP_PORT = 1900;
const SEARCH_TARGET = "urn:schemas-upnp-org:device:InternetGatewayDevice:1";
const SERVICES = [
  "urn:schemas-upnp-org:service:WANIPConnection:2",
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANPPPConnection:1",
];
const HTTP_TIMEOUT_MS = 3_000;
const ONLY_PERMANENT_LEASES = 725;

const tag = (xml, name) => new RegExp(`<(?:[A-Za-z0-9_]+:)?${name}>\\s*([^<]*?)\\s*</(?:[A-Za-z0-9_]+:)?${name}>`).exec(xml)?.[1] ?? null;

const escapeXml = (value) => String(value).replace(/[<>&'"]/g, (char) => `&#${char.charCodeAt(0)};`);

/** The LOCATION URLs that SSDP answers name, within `timeoutMs`. */
export function searchGateways({ ssdpAddress = SSDP_ADDRESS, ssdpPort = SSDP_PORT, bind = null, timeoutMs = 2_000 } = {}) {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const found = new Set();
    const done = () => {
      try {
        socket.close();
      } catch {
        // Closed already.
      }
      resolve([...found]);
    };
    socket.on("error", done);
    socket.on("message", (buffer) => {
      const location = /^location:\s*(\S+)/im.exec(buffer.toString("latin1"))?.[1];
      if (location) found.add(location);
    });
    socket.bind({ address: bind ?? undefined, port: 0 }, () => {
      const message = Buffer.from([
        "M-SEARCH * HTTP/1.1",
        `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
        'MAN: "ssdp:discover"',
        "MX: 2",
        `ST: ${SEARCH_TARGET}`,
        "", "",
      ].join("\r\n"));
      socket.send(message, ssdpPort, ssdpAddress);
      setTimeout(done, timeoutMs).unref?.();
    });
  });
}

/**
 * The gateway's connection service: { controlUrl, serviceType }, from the
 * first SSDP answer whose description the gateway itself serves.
 */
export async function findGatewayService({ gateway, fetchImpl = globalThis.fetch, search = searchGateways, ...options }) {
  const locations = (await search(options)).filter((location) => {
    try {
      return new URL(location).hostname === gateway;
    } catch {
      return false;
    }
  });
  if (!locations.length) throw new PortMapError("timeout", "No UPnP gateway answered", { protocol: "upnp" });
  for (const location of locations) {
    let xml;
    try {
      const response = await fetchImpl(location, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      xml = await response.text();
    } catch {
      continue;
    }
    const base = tag(xml, "URLBase") || location;
    const blocks = xml.match(/<service>[\s\S]*?<\/service>/g) || [];
    for (const serviceType of SERVICES) {
      const block = blocks.find((candidate) => tag(candidate, "serviceType") === serviceType);
      const control = block && tag(block, "controlURL");
      if (control) return { controlUrl: new URL(control, base).href, serviceType };
    }
  }
  throw new PortMapError("unsupported_opcode", "The gateway offers no WAN connection service", { protocol: "upnp" });
}

async function soap(service, action, args, { fetchImpl = globalThis.fetch } = {}) {
  const body = `<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service.serviceType}">${Object.entries(args).map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`).join("")}</u:${action}></s:Body></s:Envelope>`;
  let response;
  try {
    response = await fetchImpl(service.controlUrl, {
      method: "POST",
      headers: { "content-type": 'text/xml; charset="utf-8"', soapaction: `"${service.serviceType}#${action}"` },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new PortMapError("timeout", `UPnP ${action}: ${error.message}`, { protocol: "upnp" });
  }
  const text = await response.text();
  if (response.ok) return text;
  const code = Number(tag(text, "errorCode"));
  throw Object.assign(new PortMapError(code === 718 ? "conflict" : "refused", `UPnP ${action} failed: ${tag(text, "errorDescription") || `HTTP ${response.status}`}`, { protocol: "upnp" }), { upnpCode: code || null });
}

export async function upnpExternalAddress(service, options) {
  return tag(await soap(service, "GetExternalIPAddress", {}, options), "NewExternalIPAddress") || null;
}

/** Adds the mapping; a router that keeps only permanent mappings gets one. Returns the lease in seconds (0: permanent). */
export async function upnpMap(service, { internalAddress, internalPort, externalPort, lifetime, description = "Yolo media" }, options) {
  const args = (lease) => ({
    NewRemoteHost: "",
    NewExternalPort: externalPort,
    NewProtocol: "TCP",
    NewInternalPort: internalPort,
    NewInternalClient: internalAddress,
    NewEnabled: 1,
    NewPortMappingDescription: description,
    NewLeaseDuration: lease,
  });
  try {
    await soap(service, "AddPortMapping", args(lifetime), options);
    return lifetime;
  } catch (error) {
    if (error.upnpCode !== ONLY_PERMANENT_LEASES) throw error;
    await soap(service, "AddPortMapping", args(0), options);
    return 0;
  }
}

export async function upnpUnmap(service, { externalPort }, options) {
  await soap(service, "DeletePortMapping", { NewRemoteHost: "", NewExternalPort: externalPort, NewProtocol: "TCP" }, options);
}
