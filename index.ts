#!/usr/local/bin/bun run

import { Cloudflare } from 'cloudflare';

import zonefile from 'dns-zonefile'
import dns from 'dns';
import { YAML } from 'bun';
import os from 'os';

interface Config {
    nameservers: NameServer[];
    zones: Zone[];
}

interface NameServer {
    name: string;
    ipv4?: string;
    ipv6?: string;
    primary?: boolean;
}

interface Zone {
    name: string;
    file: string;
    cloudflareToken: string;
    mappings: {
        [key: string]: string;
    };
}

let ipv4: string = '';
let ipv6: string = '';

const interfaces = os.networkInterfaces();

for (const ifName of Object.keys(interfaces)) {
    for (const address of interfaces[ifName]!) {
        if (address.internal)
            continue;
        if (address.family === 'IPv4')
            ipv4 = address.address;
        if (address.family === 'IPv6' && address.scopeid === 0)
            ipv6 = address.address;
    }
}

const config = await Bun.file('config.yaml').text()
    .then((text) => YAML.parse(text) as Config)
    .catch((err) => {
        console.error(`Failed to read or parse config.yaml: ${err}`);
        console.error(`See README.md, or config.yaml.example for configuration instructions.`);
        process.exit(1);
    });

for (const zone of config.zones) {
    
    if (!zone.cloudflareToken) {
        console.error(`Zone ${zone.name} is missing a Cloudflare API token. Skipping.`);
        continue;
    }

    const cf = new Cloudflare({
        apiToken: zone.cloudflareToken,
    });

    const zones = await cf.zones.list();
    const zoneId = zones.result.find((z) => z.name === zone.name)?.id;

    if (!zoneId) {
        console.error(`Zone ${zone.name} not found in Cloudflare account.`);
        continue;
    }


    let records: Cloudflare.DNS.Record[] = [];

    // Cloudflare's API is paginated, so we have to fetch first using for await...of to get all records
    for await (const record of cf.dns.records.list({ zone_id: zoneId })) {
        records.push(record);
    }

    const now = new Date();
    const dateString = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;
    // let serial;

    const zoneFile = Bun.file(zone.file);
    const serial = await zoneFile.text()
        .then((text) => {
            const parsedZoneFile = zonefile.parse(text);
            const existingSerial = parsedZoneFile.soa?.serial;

            console.warn(`Existing zone file found at ${zone.file}.`);
            console.warn(`Existing serial number in zone file: ${existingSerial}`);

            if (existingSerial && existingSerial.toString().startsWith(dateString))
                return `${existingSerial + 1}`;
            else
                return `${dateString}01`;
        })
        .then((serial) => {
            console.warn(`Using serial number ${serial} for zone ${zone.name}.`);
            return serial;
        })
        .catch((err) => {
            console.warn(`No existing zone file found at ${zone.file}, or failed to read/parse it: ${err}`);
            console.warn(`Starting with serial number ${dateString}01`);
            return `${dateString}01`;
        });

    // Now we're going to mutate the records a bit
    for (const record of records) {
        // Simplify the record name by removing the zone name and replacing it with "@" if it's the same as the zone name
        if (record.name === zone.name)
            record.name = "@";
        else
            record.name = record.name.slice(0, -zone.name.length - 1);

        // replace the record content, if it has a 'remap=' paremeter in the comment
        const remap = record.comment?.split(' ').find((part) => part.startsWith('remap='))?.split('=')[1];

        if (remap && zone.mappings[remap]) {
            record.content = zone.mappings[remap];
        }

        if (record.type === 'CNAME') {
            // We have to do a couple special things to CNAME records
            if (record.content?.endsWith(`.${zone.name}`)) {
                // first, remove the zone name for any CNAME targets in this zone
                record.content = record.content.slice(0, -zone.name.length - 1);
            } else if (record.name !== '@') {
                // if it's not from this zone, we need to add a '.' to make it an absolute name
                // apex CNAME records have to be handled and flattened below
                record.content = `${record.content}.`;
            }
        } else if (record.type === 'MX') {
            // For MX records, we also need to make their targets absolute if they're not in this zone
            if (record.content?.endsWith(`.${zone.name}`)) {
                record.content = record.content.slice(0, -zone.name.length - 1);
            } else {
                record.content = `${record.content}.`;
            }
        }
    }

    const apexCNAME = records.find((record) => record.type === 'CNAME' && record.name === '@');

    if (apexCNAME) {
        dns.setServers(['1.1.1.1', '1.0.0.1']);

        async function resolve(name: string): Promise<Cloudflare.DNS.Record[]> {
            if (name.endsWith('.')) {
                let newRecords: Cloudflare.DNS.Record[] = [];

                for (const address of await dns.promises.lookup(name, { all: true })) {
                    newRecords.push({
                        type: address.family === 4 ? 'A' : 'AAAA',
                        name: '@',
                        content: address.address,
                        ttl: 1,
                        proxied: false,
                    });
                }

                return newRecords;
            } else {

                const namedRecords = records.filter((record) => record.name === name);

                if (namedRecords.length === 1 && namedRecords[0]!.type === 'CNAME') {
                    return resolve(namedRecords[0].content!);
                } else if (namedRecords.length > 1 && namedRecords.every((record) => record.type === 'A' || record.type === 'AAAA')) {
                    return namedRecords.map((record) => ({
                        type: record.type,
                        name: '@',
                        content: record.content!,
                        ttl: 1,
                        proxied: false,
                    }));
                }
                throw new Error(`Cannot resolve ${name} to A/AAAA records`);
            }
        }

        // If there's an apex CNAME record, we need to flatten it by replacing it with an A and AAAA record with the same content
        const newRecords = await resolve(apexCNAME.content!);

        if (newRecords.length === 0) {
            console.error(`Failed to resolve apex CNAME record ${apexCNAME.content}`);
            process.exit(1);
        }

        records.push(...newRecords);

        records.splice(records.indexOf(apexCNAME), 1);
    }

    // remove any existing NS records, and inject our own
    records = records.filter(r => !/^ns\d?$/.test(r.name)).filter(r => !(r.type === 'NS' && r.name === '@'));

    for (const ns of config.nameservers) {
        if (!ns.ipv4 && !ns.ipv6) {
            console.error(`Nameserver ${ns.name} must have at least one of ipv4 or ipv6 defined.`);
            continue;
        }

        if (ns.ipv4 === 'LOCAL')
            ns.ipv4 = ipv4;
        if (ns.ipv6 === 'LOCAL')
            ns.ipv6 = ipv6;

        records.push({
            type: 'NS',
            name: '@',
            content: ns.name,
            ttl: 1,
            proxied: false,
            comment: 'generated NS record'
        });

        if (ns.ipv4) {
            records.push({
                type: 'A',
                name: ns.name,
                content: ns.ipv4,
                ttl: 1,
                proxied: false,
                comment: 'generated NS glue'
            });
        }

        if (ns.ipv6) {
            records.push({
                type: 'AAAA',
                name: ns.name,
                content: ns.ipv6,
                ttl: 1,
                proxied: false,
                comment: 'generated NS glue'
            });
        }
    }

    // Finally, we sort the records by name, then by type, with the apex record always first

    records = records.sort((a, b) => {
        const aIsApex = a.name === '@';
        const bIsApex = b.name === '@';

        if (aIsApex !== bIsApex)
            return aIsApex ? -1 : 1;
        else return a.name.localeCompare(b.name) || a.type.localeCompare(b.type);
    });

    const masterNS = config.nameservers.find((ns) => ns.primary)
            ?? config.nameservers.find(ns => ns.name === 'ns')
            ?? config.nameservers.find(ns => ns.name === 'ns1')
            ?? config.nameservers[0];

    const nameLength = Math.max(...records.map((record) => record.name.length));
    const typeLength = Math.max(...records.map((record) => record.type.length));
    const ttlLength = Math.max(...records.map((record) => record.ttl.toString().length));
    const contentLength = Math.max(...records.map((record) => record.content?.length ?? 0));

    const soaStart = `${'@'.padEnd(nameLength)} IN ${'SOA'.padEnd(typeLength)}`;
    const soaContentStart = ''.padEnd(soaStart.length);

    const writer = zoneFile.writer();

    writer.write(`\
; Zone file for ${zone.name}
; Generated by Cloudflare to BIND converter script
$TTL 1d
${soaStart} ${masterNS!.name}.${zone.name}. admin.${zone.name}. (
${soaContentStart} ${serial} ; serial
${soaContentStart} ${'6h'.padEnd(contentLength)} ; refresh
${soaContentStart} ${'1h'.padEnd(contentLength)} ; retry
${soaContentStart} ${'4d'.padEnd(contentLength)} ; expire
${soaContentStart} ${'30m )'.padEnd(contentLength)} ; minimum

`);

    for (const record of records) {
        const name = record.name.padEnd(nameLength);
        const ttl = record.ttl.toString().padStart(ttlLength);
        const type = record.type.padEnd(typeLength);

        let content: string;

        if (record.type === 'MX')
            content = `${record.priority} ${record.content}`;
        else
            content = record.content ?? '';
        content = content.padEnd(contentLength);

        const comment = record.comment ? `; ${record.comment}` : '';
        writer.write(`${name} IN ${ttl} ${type} ${content} ${comment}\n`);
    }

    writer.write(`
; Total records: ${records.length}
; End of zone file for ${zone.name}`);

    writer.end();
}