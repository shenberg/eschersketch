<template>
  <span>
    <label v-if="label" v-html="label" :for="param"></label>
    <template v-else-if="this.$slots.default">
      <slot></slot>
    </template>
    <label v-else :for="param">{{param}}</label>
    <input class="ghost-input" type="text" @change="numchange" :name="param" :value="val" :size="size"/>
</span>
</template>

<script>
  export default {
    name: 'es-numfield',
    props: ['param', 'val', 'label', 'size'],
    methods: {
      numchange: function({type, target}){
        target.blur();
        this.$emit("numchange", this.param, target.value);
      }
    }
  }
</script>

<style scoped>
.ghost-input {
  display: inline;
  font-weight:300;
  border:0px;
  outline: none;
  -webkit-box-sizing: border-box;
  -moz-box-sizing: border-box;
  box-sizing: border-box;
  color: #4b545f;
  background: #fff;
  padding: 2px 2px;
  margin: 0px 0px;
  -webkit-transition: all 0.1s ease-in-out;
  -moz-transition: all 0.1s ease-in-out;
  -ms-transition: all 0.1s ease-in-out;
  -o-transition: all 0.1s ease-in-out;
  transition: all 0.1s ease-in-out;
}
.ghost-input:focus {
  border-bottom:1px solid #ddd;
}
</style>
