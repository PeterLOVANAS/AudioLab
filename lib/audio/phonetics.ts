/**
 * Phonetic symbol inventories and readable phone summaries.
 * Adapted from the original AudioLab-for-Mac prototype (prototype branch).
 * This file is PURE: it never accesses React, browser storage, audio or D1.
 * As a result, the same rules can be reused in the Labeller workspace and tests.
 */
export const ipaGroups={
 'Consonants':'p b t d ʈ ɖ c ɟ k ɡ q ɢ ʔ m ɱ n ɳ ɲ ŋ ɴ ʙ r ʀ ɾ ɽ ɸ β f v θ ð s z ʃ ʒ ʂ ʐ ç ʝ x ɣ χ ʁ ħ ʕ h ɦ ɬ ɮ ʋ ɹ ɻ j ɰ l ɭ ʎ ʟ w ɥ ʍ',
 'Vowels':'i y ɨ ʉ ɯ u ɪ ʏ ʊ e ø ɘ ɵ ɤ o ə ɛ œ ɜ ɞ ʌ ɔ æ ɐ a ɶ ɑ ɒ',
 'Length, stress & tone':'ː ˑ ˈ ˌ . ˥ ˦ ˧ ˨ ˩ ↗ ↘',
 'Diacritics':'ʰ ʲ ʷ ˠ ˤ ̥ ̬ ̃ ̩ ̯ ̚ ̪ ̺ ̻ ̟ ̠ ̈ ̝ ̞ ̘ ̙ ̰ ̤ ͡ ͜',
};
export function symbolGroups(config:any){
 if(config.symbols?.length)return {'Project inventory':config.symbols};
 if(config.alphabet==='ARPABET')return {'Consonants':'B CH D DH F G HH JH K L M N NG P R S SH T TH V W Y Z ZH'.split(' '),'Vowels':'AA AE AH AO AW AY EH ER EY IH IY OW OY UH UW'.split(' '),'Vowel stress':['0','1','2']};
 if(config.alphabet==='SAMPA')return {'Configure inventory':['p','b','t','d','k','g','m','n','N','f','v','s','z','S','Z','h','l','r','j','w','i','I','e','E','a','A','O','o','U','u','@',':']};
 if(config.alphabet==='X-SAMPA')return {'Consonants':'p b t d t` d` c J\\ k g q G\\ ? m F n n` J N N\\ B\\ r R\\ 4 r` f v T D s z S Z s` z` C j\\ x G X R X\\ ?\\ h h\\ l l` L L\\ w j'.split(' '),'Vowels':'i y 1 } M u I Y U e 2 @\\ 8 7 o @ E 9 3 3\\ V O { 6 a & A Q'.split(' '),'Prosody':[':',':\\','"','%','.','_H','_M','_L'],...(config.level==='narrow'?{'Diacritics':['_h','_j','_w','_0','_v','_~','_=','_^','_}','_d','_+','_-','_t','_k','_?\\','_B','_r','_o']}: {})};
 return Object.fromEntries(Object.entries(ipaGroups).filter(([k])=>k!=='Diacritics'||config.level==='narrow').map(([k,v])=>[k,v.split(' ')]));
}
export function phoneticSummary(items:any[],config:any):string{const speakers=[...new Set(items.map(x=>x.speaker||'Unassigned speaker'))];if(speakers.length>1)return speakers.map(s=>s+': '+phoneticSummary(items.filter(x=>(x.speaker||'Unassigned speaker')===s),config)).join('\n');const text=[...items].sort((a,b)=>a.start-b.start||a.end-b.end).map(x=>x.text).join(' ');return config.alphabet==='IPA'?(config.level==='phonemic'?`/${text}/`:`[${text}]`):text}
