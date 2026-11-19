import {useEffect,useState} from 'react';
import type {ITheme} from '@xterm/xterm';
import type * as Monaco from 'monaco-editor';

/** 外观偏好：深色（类 CLion Dark）、浅色（类 CLion Light）或跟随系统。 */
export type ThemePreference='dark'|'light'|'system';
export type ThemeName='dark'|'light';

const storageKey='cppide-theme';

function readPreference():ThemePreference{
  const saved=localStorage.getItem(storageKey);
  return saved==='light'||saved==='system'||saved==='dark'?saved:'dark';
}

function systemTheme():ThemeName{
  return window.matchMedia?.('(prefers-color-scheme: light)').matches?'light':'dark';
}

export function useTheme(){
  const [preference,setPreference]=useState<ThemePreference>(readPreference);
  const [system,setSystem]=useState<ThemeName>(systemTheme);
  useEffect(()=>{
    const query=window.matchMedia?.('(prefers-color-scheme: light)');if(!query)return;
    const update=()=>setSystem(query.matches?'light':'dark');query.addEventListener('change',update);return()=>query.removeEventListener('change',update);
  },[]);
  const theme:ThemeName=preference==='system'?system:preference;
  useEffect(()=>{
    document.documentElement.dataset.theme=theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#2b2d30':'#f7f8fa');
    localStorage.setItem(storageKey,preference);
  },[theme,preference]);
  return {theme,preference,setPreference};
}

/** 编辑器配色：参考 CLion 新界面的 Dark / Light 主题。 */
export function defineEditorThemes(monaco:typeof Monaco){
  monaco.editor.defineTheme('cppide-dark',{base:'vs-dark',inherit:true,rules:[
    {token:'',foreground:'bcbec4'},
    {token:'comment',foreground:'7a7e85',fontStyle:'italic'},
    {token:'keyword',foreground:'cf8e6d'},
    {token:'keyword.directive',foreground:'b3ae60'},
    {token:'keyword.directive.include',foreground:'b3ae60'},
    {token:'string',foreground:'6aab73'},
    {token:'string.include.identifier',foreground:'6aab73'},
    {token:'string.escape',foreground:'cf8e6d'},
    {token:'number',foreground:'2aacb8'},
    {token:'identifier',foreground:'bcbec4'},
    {token:'delimiter',foreground:'bcbec4'},
    {token:'annotation',foreground:'b3ae60'},
  ],colors:{
    'editor.background':'#1e1f22','editor.foreground':'#bcbec4',
    'editorLineNumber.foreground':'#4b5059','editorLineNumber.activeForeground':'#a1a3ab',
    'editor.selectionBackground':'#214283','editor.inactiveSelectionBackground':'#2a3a5c',
    'editor.lineHighlightBackground':'#26282e','editor.lineHighlightBorder':'#00000000',
    'editorCursor.foreground':'#ced0d6','editorGutter.background':'#1e1f22',
    'editorIndentGuide.background1':'#313438','editorIndentGuide.activeBackground1':'#4b4e55',
    'editorWhitespace.foreground':'#3d3f45','editorBracketMatch.background':'#43454a','editorBracketMatch.border':'#00000000',
    'editor.findMatchBackground':'#32593d','editor.findMatchHighlightBackground':'#2c4a37',
    'editorBracketHighlight.foreground1':'#bcbec4','editorBracketHighlight.foreground2':'#bcbec4','editorBracketHighlight.foreground3':'#bcbec4','editorBracketHighlight.foreground4':'#bcbec4','editorBracketHighlight.foreground5':'#bcbec4','editorBracketHighlight.foreground6':'#bcbec4',
    'editorWidget.background':'#2b2d30','editorWidget.border':'#43454a','editorSuggestWidget.selectedBackground':'#2e436e',
    'scrollbarSlider.background':'#4e515766','scrollbarSlider.hoverBackground':'#5a5d6399','scrollbarSlider.activeBackground':'#6f737a99',
  }});
  monaco.editor.defineTheme('cppide-light',{base:'vs',inherit:true,rules:[
    {token:'',foreground:'080808'},
    {token:'comment',foreground:'8c8c8c',fontStyle:'italic'},
    {token:'keyword',foreground:'0033b3'},
    {token:'keyword.directive',foreground:'9e880d'},
    {token:'keyword.directive.include',foreground:'9e880d'},
    {token:'string',foreground:'067d17'},
    {token:'string.include.identifier',foreground:'067d17'},
    {token:'string.escape',foreground:'0037a6'},
    {token:'number',foreground:'1750eb'},
    {token:'identifier',foreground:'080808'},
    {token:'delimiter',foreground:'080808'},
    {token:'annotation',foreground:'9e880d'},
  ],colors:{
    'editor.background':'#ffffff','editor.foreground':'#080808',
    'editorLineNumber.foreground':'#aeb3c2','editorLineNumber.activeForeground':'#767a8a',
    'editor.selectionBackground':'#a6d2ff','editor.inactiveSelectionBackground':'#d5e1ff',
    'editor.lineHighlightBackground':'#f5f8fe','editor.lineHighlightBorder':'#00000000',
    'editorCursor.foreground':'#000000','editorGutter.background':'#ffffff',
    'editorIndentGuide.background1':'#ebecf0','editorIndentGuide.activeBackground1':'#c9ccd6',
    'editorWhitespace.foreground':'#d3d5db','editorBracketMatch.background':'#d5e1ff','editorBracketMatch.border':'#00000000',
    'editorBracketHighlight.foreground1':'#080808','editorBracketHighlight.foreground2':'#080808','editorBracketHighlight.foreground3':'#080808','editorBracketHighlight.foreground4':'#080808','editorBracketHighlight.foreground5':'#080808','editorBracketHighlight.foreground6':'#080808',
    'editorWidget.background':'#f7f8fa','editorWidget.border':'#dfe1e5','editorSuggestWidget.selectedBackground':'#d5e1ff',
    'scrollbarSlider.background':'#c9ccd666','scrollbarSlider.hoverBackground':'#a8adbd99','scrollbarSlider.activeBackground':'#8c90a099',
  }});
}

export const terminalThemes:Record<ThemeName,ITheme>={
  dark:{background:'#1e1f22',foreground:'#dfe1e5',cursor:'#ced0d6',cursorAccent:'#1e1f22',selectionBackground:'#214283',
    black:'#1e1f22',red:'#f0524f',green:'#5fb865',yellow:'#e0b45a',blue:'#548af7',magenta:'#c77dbb',cyan:'#2aacb8',white:'#bcbec4',
    brightBlack:'#6f737a',brightRed:'#ff7c7a',brightGreen:'#8bd590',brightYellow:'#f2c55c',brightBlue:'#7ba7ff',brightMagenta:'#de9fd4',brightCyan:'#4fd1dc',brightWhite:'#ffffff'},
  light:{background:'#ffffff',foreground:'#1e1f22',cursor:'#000000',cursorAccent:'#ffffff',selectionBackground:'#a6d2ff',
    black:'#1e1f22',red:'#c7262f',green:'#1f8a3b',yellow:'#9e7700',blue:'#2753c9',magenta:'#a626a4',cyan:'#0e7c86',white:'#6c707e',
    brightBlack:'#818594',brightRed:'#e04b52',brightGreen:'#2fa84f',brightYellow:'#b88a00',brightBlue:'#3574f0',brightMagenta:'#c03fbd',brightCyan:'#139aa6',brightWhite:'#3c3f45'},
};

/** 图视图配色：青色 = 状态数组，金色 = 当前节点 / 边，绿色 = 数值改变。 */
export type GraphPalette={node:string;nodeBorder:string;nodeText:string;edge:string;edgeText:string;labelBackground:string;visited:string;visitedBorder:string;current:string;hover:string;hoverText:string;hoverBorder:string;changed:string};
export const graphPalettes:Record<ThemeName,GraphPalette>={
  dark:{node:'#2b2d30',nodeBorder:'#6f737a',nodeText:'#dfe1e5',edge:'#5a5d63',edgeText:'#bcbec4',labelBackground:'#1e1f22',visited:'#1d3b40',visitedBorder:'#2aacb8',current:'#e0b45a',hover:'#548af7',hoverText:'#ffffff',hoverBorder:'#3574f0',changed:'#73bd79'},
  light:{node:'#ffffff',nodeBorder:'#a8adbd',nodeText:'#1e1f22',edge:'#b4b8c4',edgeText:'#3c3f45',labelBackground:'#ffffff',visited:'#dcf2f4',visitedBorder:'#0e8a96',current:'#c98a00',hover:'#3574f0',hoverText:'#1e1f22',hoverBorder:'#3574f0',changed:'#208a3c'},
};
