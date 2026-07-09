/*
 * GBA Save Type Patcher - Fake RTC menu patch port.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from rtc_patcher/rtc-patcher.py in this package. The embedded
 * payload is relocated at ROM-patch time; no external build tools are needed.
 */

import { asciiBytes, copyBytes, findBytes, hexToBytes, readU32, writeU32 } from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { PAYLOAD_ALIGNMENT as TARGET_PAYLOAD_ALIGNMENT, alignedPayloadSpan, ensureDirectPayloadRegion } from "./payload-placement.js";
import { RTC_PAYLOAD_CONSTANTS, RTC_PAYLOAD_HEX } from "./rtc-data.js";

const GBA_ROM_BASE = 0x08000000;
const GBA_MAX_ROM_SIZE = 0x02000000;
const RTC_DETECTION_ALIGNMENT = 4;
const RTC_PAYLOAD_ALIGNMENT = TARGET_PAYLOAD_ALIGNMENT;
const PATCH_CODE_SECTOR_ALIGNMENT = 0x40000;
const ORIGINAL_PAYLOAD_LINK_ADDR = RTC_PAYLOAD_CONSTANTS.RTC_ORIGINAL_PAYLOAD_LINK_ADDR || 0x9000000;

export const RTC_PAYLOAD_SIZE = RTC_PAYLOAD_CONSTANTS.RTC_PAYLOAD_SIZE || 5556;

const EMBEDDED_PAYLOAD_HEX = [
  "7847c04600300fe19720a0e302f021e10e20a0e103f021e12c309fe5003093e5010013e30020a00320309fe5030052e1",
  "01308fe213ff2fe105d000b500f0c2fa02bc01200847012070470000480f000943545246012070474021c17101207047",
  "30b504007847c04600300fe19b20a0e302f021e10de08ee0ac209fe502005ee100e0a0830e50a0e103f021e101208fe2",
  "12ff2fe13c2100f02af8a0713c2100f026f86071182100f022f820710020b421b93118a2830701d101310c326d1a01d3",
  "0130f4e76d1800f01ff820700020115c01306d1afbd26d1800f016f860702800013000f011f8a07030bc012000bd0020",
  "002220236d0040415200884201d3401a0132013bf6d115000a2106df000108437047c0461f1c1f1e1f1e1f1f1e1f1e1f",
  "1f1d1f1e1f1e1f1f1e1f1e1f7f1319bc30b5c6462f3b1b0600b51b0e492b03d82c4c9b00e3589f46172318259c460388",
  "5c1c0480e024e404a0466446db0043441a8059809c800024a446dc8003885c1cdb004344083204801a80624659809d80",
  "da8020bca84630bc01bc004719231a259c46dce7132314259c46d8e7042305259c46d4e7062307259c46d0e715231625",
  "9c46cce710230d259c46c8e7112312259c46c4e7082309259c46c0e70a230b259c46bce70c230d259c46b8e70e230f25",
  "9c46b4e7022303259c46b0e7002301259c46ace7b80d0009f0b5de46454657464e46e0b589b0994612ab0600187813ab",
  "1f7814ab8046187815ab8b460090fa2118780023019002a84380851c89003000924600f0b7fd00040a21001400f0a0fd",
  "03ac303130002170642100f0abfd00040a21001400f094fd3031300061700a2100f0a0fd00040a21001400f089fd3031",
  "3000a1700a2100f087fd2f263031e17026710a21584600f08dfd303060710a21584600f079fd3031a171e6710a215046",
  "00f080fd303020720a21504600f06cfd3031617248460a2100f074fd3030a0720a21484600f060fd0b363031e1722673",
  "0a21404600f066fd303060730a21404600f052fd30313800a173e6730a2100f059fd303020740a21380000f045fd3b4e",
  "3700303161742437237831884f2228000236fff70dff0134be42f5d1009f0a21380000f03ffd00060a21000e00f02cfd",
  "38000c060a2100f027fd240e0e00632f3ed8002c48d1303633064f22cd2128001b0efff7edfe78235022d5212800fff7",
  "e7fe019822494000415ae0202a88c004531cd200121846200439108051801b21918000211b04d1801b0c7f2b0fd8e022",
  "12049a18bb30d200ff3001331b0410801b0c51809180d1800832802bf5d109b0f0bcbb46b246a946a046f0bc01bc0047",
  "6421380000f0eefc303003064f22bd2128001b0efff7acfe303423064f22c52128001b0efff7a4feade7c0460c0f0009",
  "fc0e000910b5944682b0062905d86d4a8b00d3589f46013bc37102b010bc01bc004762468379012a00d09be000223a2b",
  "00d85a1c8271f0e76246c379012aead1ff2b00d1b6e00133c371e6e762460388012a7cd15c4a934200d89ee0fa23db00",
  "038083780021002b06d0191c0c2b00d90c210906090e013962465200534b624492009b18c2785b5c002a19d1c370c4e7",
  "62468378012a6cd1002294460b2b76d90323817001880b4059424b415900474acb189b00d2186346d35cc278002ae5d0",
  "9342aad2c370a8e762460379012a33d10022162b00d85a1c02719ee762464379012a23d100223a2b00d85a1c427194e7",
  "827800240188002a05d0131c0c2a53d81b061b0e5c1e03230b4059424b415900cb1861462d4a9b00d218125dc3780129",
  "10d19a4200d9591cc17076e73b22002bdcd05a1e427170e71722002bccd05a1e02716ae7012b00d95a1ec27065e7fa22",
  "d20093422ad90322013b1a40514251418c467de73b22002b00d163e75a1e827153e7012b21d9591e0a060b1c120e0c2a",
  "00d90c231b061b0e013b9c4688e701331b06190e4b1e9c4682e7032201331a40514251418c465be70c23a9e70022084b",
  "944655e70023c3712fe70b230c219c466ee7c046e00e000932080000300f000933080000f0b5de4657464e4645460023",
  "e0b58fb00a93013b0b9300f0e7fb041e00d0cbe1002300279c46984699469d489d4a03881a4008929c4a9d4d11882b40",
  "09910380002380201380803a1080994a1380994a1380a023984d9948db04ea5a1a8002338342fad1964b974d9748ea5a",
  "1a8002338342fad1954bc0201d00c0044135ff35c01a1a88c25202339d42fad10020904b904a188002339342fbd18f4d",
  "8f48904e03003c3bea5a1a8002339842fad14030043db042f4d1e0228a4b8b4892009d18c01a1a88c2520233ab42fad1",
  "e022874b52011a808a22083b52011a808025e02300228348db04ad001d805a809a80da8008338342f8d1fa20b6256e22",
  "03237d4ec0006d00ff321900014003420ad1944213d91900013000046f3c000cff3c01400342f4d0ac4208d901300004",
  "000cb04200d16ce16e3cff3ce5e74b424b415a006d4dd21892000121aa1803e001310906e41a090e0023002906d00b1c",
  "0c2900d90c231b061b0e013bd35ca342eed943460cae33716346b3714b46f371002301342206120e77713080b170f270",
  "03934b4602936346009701934346fff74bfd002300279b4699469846544c23889f2bfcd823889f2bfcd9524b1b88db43",
  "9a469b05079352462023134208d03b4206d15b46002b62d0013b1b061b0e9b4610235246134209d03b4207d158460721",
  "013000f0e9fa09060b0e9b46402352461a400592524613420bd01a003a4005923b4237d0434601331b041b0c05930a2b",
  "30d8802352461a409046524613420bd01a003a4090463b422ad04b4601331b041b0c98460a2b23d8f379994633790693",
  "5b46f278b178308803934b460293b379019373790093069bfff7e6fc09235246134201d03b4247d0059bc1469846079b",
  "9f0d94e7012259463000fff7d3fdc8e70122594630005242fff7ccfdd4e706239b469de782000004ff77000080000004",
  "ff440000100000041200000494150004200000050002000574130004200200053414000900e0000600e800060c31ff02",
  "fce100067ce300064c0f000900000106080000040004000734080000300f000906000004300100043379984673799c46",
  "b3799a46fa2330880021b478f778db0098420ed9a34603221a4014006242624101336e32ff321b0489181b0c9842f2d1",
  "5c46012c17d9032303405a42534101225800c01880002818131c0c2a00d90c231b061b0ec318013b1b7801321206c918",
  "120e9442f0d1013f7f187a00d219d200424413019b1a9b00634418014a46c01a534680009b1ac018494600f01ffa089a",
  "314b1a80314b099a1a800fb0f0bcbb46b246a946a046f0bc01bc00470ba90aa800f0faf90b9a13061b0e99460a9d284b",
  "9d4223d9ff2414406419ac4212d2a34210d33c21200000f0fdf93c210706200000f0eaf909060b0e9c46002300249846",
  "3f0e14e6002300279c469846002499460de6b62400231748640092e62800164900f0e0f914490400280000f0cdf90d00",
  "e1212800090100f0d5f9e1210006030e09012800984600f0bff90d003c21280000f0c8f93c210706280000f0b5f90906",
  "0b0e9c463f0ee2e582000004800000047f1319bc330800008051010000200fe19b30a0e303f021e100e0a0e101d0a0e1",
  "9730a0e303f021e1a4e09fe502f021e11eff2fe100200fe19b30a0e303f021e10e30a0e10dc0a0e102f021e1003080e5",
  "00c081e51eff2fe130002de900200fe19730a0e303f021e10e40a0e19b30a0e303f021e10e30a0e10d50a0e102f021e1",
  "4c209fe5020054e10400001a003080e50050c1e50100a0e33000bde81eff2fe10000a0e33000bde81eff2fe100200fe1",
  "9730a0e303f021e10e00a0e102f021e10c109fe5010050e10100a0030000a0131eff2fe143545246012051e21eff2f01",
  "3600003a010050e12200009a020011e12300000a0e0211e38111a0010830a0030130a013010251e3000051310112a031",
  "0332a031faffff3a020151e3000051318110a0318330a031faffff3a0020a0e3010050e10100402003208221a10050e1",
  "a1004020a3208221210150e12101402023218221a10150e1a1014020a3218221000050e32332b0112112a011efffff1a",
  "0200a0e11eff2fe10100a0030000a0131eff2fe1010851e32118a0211020a0230020a033010c51e32114a02108208222",
  "100051e32112a02104208222040051e303208282a12082903002a0e11eff2fe11fff2fe10000a0e1000050e30000e013",
  "620000ea000051e3f8ffff0a03402de9bcffffeb0640bde8920003e0031041e01eff2fe1000051e34300000a01c020e0",
  "00106142012051e22700000a0030b0e100306042010053e12600009a020011e12800000a0e0211e38111a0010820a003",
  "0120a013010251e3030051310112a0310222a031faffff3a020151e3030051318110a0318220a031faffff3a0000a0e3",
  "010053e10130432002008021a10053e1a1304320a2008021210153e12131432022018021a10153e1a1314320a2018021",
  "000053e32222b0112112a011efffff1a00005ce3000060421eff2fe100003ce1000060421eff2fe10000a033cc0fa001",
  "010080031eff2fe1010851e32118a0211020a0230020a033010c51e32114a02108208222100051e32112a02104208222",
  "040051e303208282a120829000005ce33302a0e1000060421eff2fe11fff2fe10000a0e1000050e30201e0c30201a0b3",
  "0e0000ea000051e3f7ffff0a03402de9b1ffffeb0640bde8920003e0031041e01eff2fe17047c0467847fde738ffffea",
  "7847fde7f2ffffea7847fde79cffffea00c09fe51cff2fe1750d00097847fde725ffffea7847fde756ffffea7847fde7",
  "49ffffea0000000094010009ec010009e40100099c010009a4010009c4010009cc010009d4010009dc010009b4010009",
  "bc010009ac01000948010009480100094801000948010009480100094801000948010009480100094801000948010009",
  "480100094801000948010009480100094801000948010009480100094801000948010009480100094801000948010009",
  "480100094801000948010009480100094801000948010009480100098c01000948010009480100094801000948010009",
  "480100094801000948010009480100094801000948010009480100094801000948010009480100094801000948010009",
  "480100094801000948010009480100094801000948010009480100094801000948010009480100094801000948010009",
  "4801000948010009480100098c0100093c04000980040009e0040009b8040009cc040009120400092804000930004800",
  "610078009000a800d100000014001c0024002c0034003c0044004c0055005d006d0074007d0084008c0095009c00a400",
  "1f1c1f1e1f1e1f1f1e1f1e1f1f1d1f1e1f1e1f1f1e1f1e1f000000000000000000000000000000000022320020332303",
  "200320032003200320032003200320032003200320032003302232030033330000000000000000000000000000000000",
  "000000000000000000200300002203000023030000200300002003000020030000200300002003000022320000333300",
  "000000000000000000000000000000000000000000000000002232002033230320032003300320030000320300203300",
  "003203002033000020222203303333030000000000000000000000000000000000000000000000000022320020332303",
  "200320033003200300203203003023032003200320032003302232030033330000000000000000000000000000000000",
  "000000000000000000203200003232000032320020333200200332002003320020222203303332030000320000003300",
  "000000000000000000000000000000000000000000000000202222032033330320030000200300002022320030332303",
  "000020032003200330223203003333000000000000000000000000000000000000000000000000000022320020332303",
  "200330032003000020223200203323032003200320032003302232030033330000000000000000000000000000000000",
  "000000000000000020222203303323030000200300002003000032030000320000203300002003000020030000300300",
  "000000000000000000000000000000000000000000000000002232002033230320032003200320033022320300000000",
  "000000000000000000223200203323032003200320032003302222030033230300002003200320033022320300333300",
  "000000000000000000000000000000000000000000002003000020030000320300003200002033000020030000320300",
  "003200002033000020030000300300000000000000000000000000000000000000000000000000000000000000220300",
  "002203000033030000000000000000000022030000220300003303000000000000000000000000000000000000000000",
  "000000000000000000000000000000000000000000000000202222022022220200000000000000000000000000000000",
  "000000000000000000000000000000000000000000000000000000002003003230322033002332030020320000322303",
  "203330323003003300000000000000000000000000000000000000000022030000220300002203002222220323223203",
  "302233000033030000000000010002000200020002000200020002000200020002000200020002000200020002000200",
  "020002000200020002000200020002000200020002000300040005000500050005000500050005000500050005000500",
  "050005000500050005000500050005000500050005000500050005000500050005000600040005000500050005000500",
  "050005000500050005000500050005000500050005000500050005000500050005000500050005000500050005000600",
  "040005000500050005000500050005000500050005000500050005000500050005000500050005000500050005000500",
  "050005000500050005000600040005000500050005000500050005000500050005000500050005000500050005000500",
  "050005000500050005000500050005000500050005000600070008000800080008000800080008000800080008000800",
  "080008000800080008000800080008000800080008000800080008000800080008000900000000000000000000000000",
  "000000000000000000000000000000000000000000000000001111111021333310545555105655551056558710567599",
  "105685990000000011111111333333335555555555555555888888889999999999999999000000001111110033331201",
  "555545015555650178556501995765019958650110568599105685991056859910568599105685991056859910568599",
  "105685999999999999999999999999999999999999999999999999999999999999999999995865019958650199586501",
  "995865019958650199586501995865019958650110568599105675991056558710465555102654551061666600111111",
  "000000009999999999999999888888885555555555555555666666661111111100000000995865019957650178556501",
  "55556401554562016666160111111100000000000000ff7f8c315a670000000000000000000000000000000000000000",
  "000000000000c518ce5531668c49ae412935f5565b6fff7f000000000000000000000000",
].join("");

const RELOCATION_OFFSETS = [0x4C, 0x1F4, 0x3EC, 0x3F0, 0x5B4, 0x5BC, 0x890, 0x8A8, 0x8BC, 0xD98, 0xDB8, 0xDBC, 0xDC0, 0xDC4, 0xDC8, 0xDCC, 0xDD0, 0xDD4, 0xDD8, 0xDDC, 0xDE0, 0xDE4, 0xDE8, 0xDEC, 0xDF0, 0xDF4, 0xDF8, 0xDFC, 0xE00, 0xE04, 0xE08, 0xE0C, 0xE10, 0xE14, 0xE18, 0xE1C, 0xE20, 0xE24, 0xE28, 0xE2C, 0xE30, 0xE34, 0xE38, 0xE3C, 0xE40, 0xE44, 0xE48, 0xE4C, 0xE50, 0xE54, 0xE58, 0xE5C, 0xE60, 0xE64, 0xE68, 0xE6C, 0xE70, 0xE74, 0xE78, 0xE7C, 0xE80, 0xE84, 0xE88, 0xE8C, 0xE90, 0xE94, 0xE98, 0xE9C, 0xEA0, 0xEA4, 0xEA8, 0xEAC, 0xEB0, 0xEB4, 0xEB8, 0xEBC, 0xEC0, 0xEC4, 0xEC8, 0xECC, 0xED0, 0xED4, 0xED8, 0xEDC, 0xEE0, 0xEE4, 0xEE8, 0xEEC, 0xEF0, 0xEF4, 0xEF8];
// GCC folded a few asset-source addresses into constants like
// (source - palette/VRAM destination). They are not normal ABS32 pointers,
// but the source side still has to move with the relocated payload. Without
// these addend relocations the RTC logic runs, while palettes/tilemaps are
// copied from the original 0x0900xxxx link area, producing a white menu.
const RELATIVE_ASSET_RELOCATION_OFFSETS = [0x87C, 0x888, 0x89C];
const ORIGINAL_PAYLOAD_SYMBOLS = {
  "payload_getstatus": 0x09000058,
  "payload_gettimedate": 0x09000060,
  "payload_probe": 0x09000000,
  "payload_reset": 0x09000054
};
const ACTIVE_RELOCATION_OFFSETS = RTC_PAYLOAD_CONSTANTS.RTC_RELOCATION_OFFSETS || RELOCATION_OFFSETS;
const ACTIVE_RELATIVE_ASSET_RELOCATION_OFFSETS = RTC_PAYLOAD_CONSTANTS.RTC_RELATIVE_ASSET_RELOCATION_OFFSETS || RELATIVE_ASSET_RELOCATION_OFFSETS;
const ACTIVE_ORIGINAL_PAYLOAD_SYMBOLS = RTC_PAYLOAD_CONSTANTS.RTC_ORIGINAL_PAYLOAD_SYMBOLS || ORIGINAL_PAYLOAD_SYMBOLS;
const SIGS = {
  "probe": [
    46464,
    45188,
    18031,
    7481,
    7176,
    61440,
    0,
    1537,
    3592,
    10240,
    0,
    8192
  ],
  "reset": [
    46464,
    45188,
    18031,
    18435,
    30721,
    10497,
    0,
    8192
  ],
  "getstatus": [
    46480,
    45186,
    18031,
    24632,
    18434,
    30721,
    10497,
    0,
    8192,
    0,
    0,
    0,
    0,
    8449,
    28673,
    0,
    8449,
    32769,
    0,
    8453,
    32769,
    0,
    8455,
    32769
  ],
  "gettimedate": [
    46464,
    45186,
    18031,
    24632,
    18434,
    30721,
    10497,
    0,
    8192,
    0,
    0,
    0,
    0,
    8449,
    28673,
    0,
    8449,
    32769,
    0,
    8453,
    32769,
    0,
    8455,
    32769,
    8293
  ]
};

// Additional handler signatures for Pokémon Unbound-style FireRed RTC code.
// The original signatures above identify the common SiiRTC implementation.
// Unbound keeps RTC/GPIO routines, but the compiler output/prologues differ,
// so the standard exact signatures do not match. Zero halfwords are wildcards
// for branch immediates or ROM-version-sensitive values.
const ADDITIONAL_SIGS = {
  "probe": [
    [
      0xB530, 0xB085, 0xAD01, 0x0028, 0xF7FF, 0x0000, 0x2800, 0xD102,
      0x2000, 0xB005, 0xBD30, 0x79EB, 0x065B, 0xD411, 0xF7FF, 0x0000,
      0x2401, 0x2800, 0xD0F4, 0x0028,
    ],
  ],
  "reset": [
    [0x2201, 0x4B03, 0x801A, 0x2200, 0x4B02, 0x701A, 0x4770, 0x46C0],
  ],
  "getstatus": [
    [
      0xB5F7, 0x4F16, 0x783B, 0x9001, 0x2600, 0x2B01, 0xD024, 0x2401,
      0x2305, 0x4D13, 0x4A13, 0x703C, 0x802C, 0x802B, 0x3302, 0x8013,
      0x2063, 0xF7FF, 0x0000, 0x2305, 0x4A0E, 0x8013, 0xF7FF, 0x0000,
    ],
  ],
  "gettimedate": [
    [
      0xB5F7, 0x4E14, 0x7833, 0x0005, 0x2000, 0x2B01, 0xD020, 0x2301,
      0x4C11, 0x7033, 0x4F11, 0x8023, 0x3304, 0x8023, 0x3302, 0x803B,
      0x3065, 0xF7FF, 0x0000, 0x2305, 0x803B, 0x002F, 0x1DEB, 0x9301,
      0xF7FF, 0x0000,
    ],
  ],
};

const PATCH_ORDER = ["probe", "reset", "getstatus", "gettimedate"];
const PAYLOAD_SYMBOLS = {
  "probe": "payload_probe",
  "reset": "payload_reset",
  "getstatus": "payload_getstatus",
  "gettimedate": "payload_gettimedate"
};

const EMBEDDED_PAYLOAD = hexToBytes(RTC_PAYLOAD_HEX || EMBEDDED_PAYLOAD_HEX);
const RTC_PAYLOAD_MARKER = EMBEDDED_PAYLOAD.slice(0, 64);
const RTC_ROM_MARKER_TEXT = "lk_rtc_runtime";

function addOperation(operations, name, offset, size, details = {}) {
  const operation = { name, offset, size };
  if (details.codeName !== undefined) operation.code_name = details.codeName;
  if (details.value !== undefined) operation.value = details.value;
  if (details.oldBytes !== undefined) operation.old_bytes = details.oldBytes;
  if (details.newBytes !== undefined) operation.new_bytes = details.newBytes;
  operations.push(operation);
}

function alignDown(value, alignment) {
  return value - (value % alignment);
}

function alignUp(value, alignment) {
  return alignDown(value + alignment - 1, alignment);
}

function isFreeByte(value) {
  return value === 0x00 || value === 0xff;
}

export function isRtcFreeRegion(bytes, start, size) {
  if (start < 0 || size < 0 || start + size > bytes.length) return false;
  for (let offset = start; offset < start + size; offset += 1) {
    if (!isFreeByte(bytes[offset])) return false;
  }
  return true;
}

function writeRtcRomMarker(bytes, operations, payloadOffset) {
  const marker = asciiBytes(RTC_ROM_MARKER_TEXT);
  const markerOffset = payloadOffset + RTC_PAYLOAD_SIZE;
  const markerEnd = markerOffset + marker.length;
  const paddingEnd = payloadOffset + alignedPayloadSpan(RTC_PAYLOAD_SIZE);
  if (markerEnd > paddingEnd || markerEnd > bytes.length) return false;
  if (!isRtcFreeRegion(bytes, markerOffset, marker.length)) return false;
  copyBytes(bytes, markerOffset, marker);
  addOperation(operations, "RTC ROM marker", markerOffset, marker.length, { codeName: "rtc_rom_marker" });
  return true;
}

function rangesOverlap(start, end, ranges) {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

function resizeRom(rom, newSize, fillValue = 0xff) {
  if (newSize <= rom.bytes.length) return;
  const expanded = new Uint8Array(newSize);
  expanded.fill(fillValue);
  expanded.set(rom.bytes);
  rom.bytes = expanded;
}

function embeddedPayloadBytes() {
  if (EMBEDDED_PAYLOAD.length !== RTC_PAYLOAD_SIZE) {
    throw new PatchError(`RTC: embedded payload size mismatch: expected ${RTC_PAYLOAD_SIZE}, got ${EMBEDDED_PAYLOAD.length}`);
  }
  return EMBEDDED_PAYLOAD;
}

function relocatePayload(payload, newLinkAddr) {
  const delta = newLinkAddr - ORIGINAL_PAYLOAD_LINK_ADDR;
  const relocated = new Uint8Array(payload);

  for (const offset of ACTIVE_RELOCATION_OFFSETS) {
    if (offset + 4 > relocated.length) throw new PatchError(`RTC: bad relocation offset 0x${offset.toString(16)} outside payload`);
    const oldValue = readU32(relocated, offset);
    const oldTarget = (oldValue & 0xfffffffe) >>> 0;
    if (oldTarget < ORIGINAL_PAYLOAD_LINK_ADDR || oldTarget >= ORIGINAL_PAYLOAD_LINK_ADDR + payload.length) {
      throw new PatchError(`RTC: relocation sanity check failed at 0x${offset.toString(16)}`);
    }
    writeU32(relocated, offset, (oldValue + delta) >>> 0);
  }

  for (const offset of ACTIVE_RELATIVE_ASSET_RELOCATION_OFFSETS) {
    if (offset + 4 > relocated.length) throw new PatchError(`RTC: bad relative relocation offset 0x${offset.toString(16)} outside payload`);
    const oldValue = readU32(relocated, offset);
    writeU32(relocated, offset, (oldValue + delta) >>> 0);
  }

  const symbols = {};
  for (const [name, address] of Object.entries(ACTIVE_ORIGINAL_PAYLOAD_SYMBOLS)) {
    symbols[name] = (address + delta) >>> 0;
  }
  return { payloadBytes: relocated, symbols };
}

function findAlignedMarker(bytes, marker, start = 0, end = bytes.length, alignment = 1) {
  const limit = Math.min(end, bytes.length);
  let pos = Math.max(0, start);
  while (pos < limit) {
    pos = findBytes(bytes, marker, pos, limit);
    if (pos < 0) return null;
    if (alignment <= 1 || pos % alignment === 0) return pos;
    pos += 1;
  }
  return null;
}

export function findRtcPayloadBase(bytes) {
  if (!RTC_PAYLOAD_MARKER.length) return null;
  let pos = 0;
  while (true) {
    const markerOffset = findAlignedMarker(bytes, RTC_PAYLOAD_MARKER, pos, bytes.length, RTC_DETECTION_ALIGNMENT);
    if (markerOffset === null) return null;
    if (markerOffset + RTC_PAYLOAD_SIZE <= bytes.length) return markerOffset;
    pos = markerOffset + RTC_DETECTION_ALIGNMENT;
  }
}

function lastNonEmptyPatchCodeBlockStart(bytes) {
  let blockStart = alignDown(Math.max(0, bytes.length - 1), PATCH_CODE_SECTOR_ALIGNMENT);
  while (blockStart >= 0) {
    const blockEnd = Math.min(blockStart + PATCH_CODE_SECTOR_ALIGNMENT, bytes.length);
    let hasData = false;
    for (let offset = blockStart; offset < blockEnd; offset += 1) {
      if (!isFreeByte(bytes[offset])) {
        hasData = true;
        break;
      }
    }
    if (hasData) return blockStart;
    blockStart -= PATCH_CODE_SECTOR_ALIGNMENT;
  }
  return null;
}

function findPatchCodeSectorFreeRegion(bytes, size, excludedRanges = []) {
  const lastContentBlock = lastNonEmptyPatchCodeBlockStart(bytes);
  if (lastContentBlock === null) return null;

  let blockStart = lastContentBlock;
  while (blockStart + PATCH_CODE_SECTOR_ALIGNMENT <= bytes.length) {
    const blockEnd = blockStart + PATCH_CODE_SECTOR_ALIGNMENT;
    const payloadBase = alignDown(blockEnd - size, RTC_PAYLOAD_ALIGNMENT);
    if (
      payloadBase >= blockStart
      && !rangesOverlap(payloadBase, payloadBase + size, excludedRanges)
      && isRtcFreeRegion(bytes, payloadBase, size)
    ) {
      return payloadBase;
    }
    blockStart += PATCH_CODE_SECTOR_ALIGNMENT;
  }
  return null;
}

export function ensureRtcPatchCodeRegion(rom, operations, warnings, size = RTC_PAYLOAD_SIZE, excludedRanges = []) {
  return ensureDirectPayloadRegion(rom, operations, warnings, alignedPayloadSpan(size), "RTC", excludedRanges);
}

function halfwordAt(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function matchesSig(bytes, offset, sig) {
  if (offset & 3) return false;
  const end = offset + sig.length * 2;
  if (end > bytes.length) return false;
  for (let index = 0; index < sig.length; index += 1) {
    const expected = sig[index];
    if (expected && halfwordAt(bytes, offset + index * 2) !== expected) return false;
  }
  return true;
}

function firstBytesForSig(sig) {
  if (sig.length < 2 || sig[0] === 0 || sig[1] === 0) throw new PatchError("RTC: handler signature cannot be indexed");
  return new Uint8Array([sig[0] & 0xff, (sig[0] >>> 8) & 0xff, sig[1] & 0xff, (sig[1] >>> 8) & 0xff]);
}

function findAllSig(bytes, sig) {
  const first = firstBytesForSig(sig);
  const found = [];
  let pos = 0;
  while (true) {
    pos = findBytes(bytes, first, pos);
    if (pos < 0) break;
    if (matchesSig(bytes, pos, sig)) found.push(pos);
    pos += 1;
  }
  return found;
}

function signatureVariants(name) {
  return [SIGS[name], ...(ADDITIONAL_SIGS[name] || [])];
}

function findRtcHandlers(bytes, excludedRanges = []) {
  const matches = [];
  const problems = [];

  for (const name of PATCH_ORDER) {
    const candidatesByOffset = new Map();
    for (const sig of signatureVariants(name)) {
      for (const offset of findAllSig(bytes, sig)) {
        // Multiple variants may intentionally identify the same handler.
        // Keep the longest replacement window for that offset.
        const size = sig.length * 2;
        if (rangesOverlap(offset, offset + size, excludedRanges)) continue;
        candidatesByOffset.set(offset, Math.max(candidatesByOffset.get(offset) || 0, size));
      }
    }

    const candidates = [...candidatesByOffset.entries()].sort((a, b) => a[0] - b[0]);
    if (candidates.length !== 1) {
      const formatted = candidates.length ? candidates.map(([offset]) => `0x${offset.toString(16).padStart(6, "0")}`).join(", ") : "none";
      problems.push(`${name}: expected 1 match, found ${candidates.length} (${formatted})`);
    } else {
      const [offset, size] = candidates[0];
      matches.push({ name, offset, size });
    }
  }

  if (problems.length) throw new PatchError(`RTC handler detection failed:\n  ${problems.join("\n  ")}`);
  return matches;
}

function makeThumbJumpStub(targetAddr, totalSize) {
  if (totalSize < 8) throw new PatchError(`RTC: need at least 8 bytes for Thumb jump stub, got ${totalSize}`);
  const stub = new Uint8Array(totalSize);
  stub[0] = 0x00;
  stub[1] = 0x4b;
  stub[2] = 0x18;
  stub[3] = 0x47;
  writeU32(stub, 4, (targetAddr | 1) >>> 0);
  for (let offset = 8; offset < totalSize; offset += 2) {
    stub[offset] = 0xc0;
    if (offset + 1 < totalSize) stub[offset + 1] = 0x46;
  }
  return stub;
}

function validatePayloadOffset(bytes, payloadOffset) {
  if (!Number.isInteger(payloadOffset)) throw new PatchError("RTC: payload offset is invalid");
  if (payloadOffset % RTC_PAYLOAD_ALIGNMENT) throw new PatchError("RTC: payload offset must be 0x100-byte aligned");
  if (payloadOffset < 0 || payloadOffset + RTC_PAYLOAD_SIZE > GBA_MAX_ROM_SIZE) {
    throw new PatchError("RTC: payload would be outside the 32 MiB GBA ROM address space");
  }
  if (payloadOffset < bytes.length && !isRtcFreeRegion(bytes, payloadOffset, Math.min(RTC_PAYLOAD_SIZE, bytes.length - payloadOffset))) {
    throw new PatchError("RTC: chosen payload region is not free");
  }
}

function patchRtcOnWorkingRom(workRom, operations, warnings, originalBytes, context = {}) {
  const existingBase = findRtcPayloadBase(originalBytes);
  if (existingBase !== null) {
    const markerWritten = writeRtcRomMarker(workRom.bytes, operations, existingBase);
    const existingLinkAddr = (GBA_ROM_BASE + existingBase) >>> 0;
    const existingDelta = existingLinkAddr - ORIGINAL_PAYLOAD_LINK_ADDR;
    const runtimeMenuSymbol = ACTIVE_ORIGINAL_PAYLOAD_SYMBOLS.fake_rtc_menu_run_runtime;
    return {
      requested: true,
      status: markerWritten ? "repaired" : "already_patched",
      payload_offset: existingBase,
      runtime_base: existingLinkAddr,
      runtime_menu_entry: runtimeMenuSymbol === undefined ? null : ((runtimeMenuSymbol + existingDelta) | 1) >>> 0,
      size: RTC_PAYLOAD_SIZE,
      graphics_relocations: ACTIVE_RELATIVE_ASSET_RELOCATION_OFFSETS.length,
    };
  }

  const matches = findRtcHandlers(originalBytes, context.excludedRanges || []);
  let payloadOffset = context.payloadOffset ?? null;
  const placement = context.placement || (payloadOffset === null ? "patch-code-sector" : "manual");

  if (payloadOffset === null) {
    payloadOffset = ensureRtcPatchCodeRegion(workRom, operations, warnings, RTC_PAYLOAD_SIZE, context.excludedRanges || []);
    if (payloadOffset === null) {
      return { requested: true, status: "failed", size: RTC_PAYLOAD_SIZE };
    }
  } else {
    validatePayloadOffset(workRom.bytes, payloadOffset);
    const end = payloadOffset + RTC_PAYLOAD_SIZE;
    if (end > workRom.bytes.length) {
      const oldSize = workRom.bytes.length;
      resizeRom(workRom, end, 0xff);
      addOperation(operations, "RTC ROM expansion", oldSize, end - oldSize, { value: end });
    }
  }

  const end = payloadOffset + RTC_PAYLOAD_SIZE;
  const region = workRom.bytes.slice(payloadOffset, end);
  if (!isRtcFreeRegion(region, 0, region.length)) throw new PatchError("RTC: chosen payload region is not free");

  const linkAddr = (GBA_ROM_BASE + payloadOffset) >>> 0;
  const payloadBuild = relocatePayload(embeddedPayloadBytes(), linkAddr);
  copyBytes(workRom.bytes, payloadOffset, payloadBuild.payloadBytes);
  addOperation(operations, "RTC payload", payloadOffset, payloadBuild.payloadBytes.length, { codeName: "rtc_payload", value: linkAddr });
  writeRtcRomMarker(workRom.bytes, operations, payloadOffset);

  const handlerResults = [];
  for (const match of matches) {
    const symbolName = PAYLOAD_SYMBOLS[match.name];
    const target = payloadBuild.symbols[symbolName];
    if (target === undefined) throw new PatchError(`RTC: missing payload symbol for ${match.name}`);
    const stub = makeThumbJumpStub(target, match.size);
    copyBytes(workRom.bytes, match.offset, stub);
    addOperation(operations, `RTC ${match.name} hook`, match.offset, match.size, { codeName: `rtc_${match.name}_hook`, value: target >>> 0 });
    handlerResults.push({ name: match.name, offset: match.offset, size: match.size, target: target >>> 0 });
  }

  return {
    requested: true,
    status: "patched",
    payload_offset: payloadOffset,
    runtime_base: linkAddr,
    runtime_menu_entry: payloadBuild.symbols.fake_rtc_menu_run_runtime === undefined ? null : (payloadBuild.symbols.fake_rtc_menu_run_runtime | 1) >>> 0,
    size: RTC_PAYLOAD_SIZE,
    placement,
    relocations: ACTIVE_RELOCATION_OFFSETS.length + ACTIVE_RELATIVE_ASSET_RELOCATION_OFFSETS.length,
    graphics_relocations: ACTIVE_RELATIVE_ASSET_RELOCATION_OFFSETS.length,
    handlers: handlerResults,
  };
}

export function applyRtcForPipeline(rom, operations, warnings, rtcOptions = {}, context = {}) {
  if (!rtcOptions?.enabled) return null;

  const originalBytes = new Uint8Array(rom.bytes);
  const workRom = { bytes: new Uint8Array(rom.bytes) };
  const localOperations = [];
  const localWarnings = [];

  try {
    const rtc = patchRtcOnWorkingRom(workRom, localOperations, localWarnings, originalBytes, context);
    rom.bytes = workRom.bytes;
    operations.push(...localOperations);
    warnings.push(...localWarnings);
    return rtc;
  } catch (error) {
    localWarnings.push(error.message || String(error));
    warnings.push(...localWarnings);
    return { requested: true, status: "failed", size: RTC_PAYLOAD_SIZE };
  }
}

export function applyRtcToBytes(inputBytes, rtcOptions = {}, context = {}) {
  const rom = { bytes: new Uint8Array(inputBytes) };
  const operations = [];
  const warnings = [];
  const rtc = applyRtcForPipeline(rom, operations, warnings, rtcOptions, context);
  const status = operations.length ? "patched" : rtc?.status || "unchanged";
  const result = { rtc, operations, warnings, status };
  return { bytes: rom.bytes, result };
}
